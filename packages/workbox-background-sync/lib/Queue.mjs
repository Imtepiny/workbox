/*
 Copyright 2017 Google Inc. All Rights Reserved.
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

import {_private} from 'workbox-core';
import StorableRequest from './StorableRequest.mjs';


const {indexedDBHelper, WorkboxError} = _private;
const names = new Set();


const DB_NAME = 'workbox-background-sync';
const TAG_PREFIX = 'workbox-background-sync';
const OBJECT_STORE_NAME = 'requests';
const MAX_RETENTION_TIME = 1000 * 60 * 60 * 24 * 7; // 7 days


/**
 * A class to manage storing failed requests in IndexedDB and retrying them
 * later. All parts of the storing and replaying process are observable via
 * callbacks.
 *
 * @example
 * // Manually detecting failed requests and added them to the queue.
 * const bgQueue = new workbox.backgroundSync.Queue('myQueue');
 * self.addEventListener('fetch', function(event) {
 *   if (!event.request.url.startsWith('https://example.com')) return;
 *
 *   const clone = event.request.clone();
 *   event.respondWith(fetch(event.request).catch((err) => {
 *     bgQueue.addRequest(clone);
 *     throw err;
 *   }));
 * });
 *
 * @memberof module:workbox-background-sync
 */
export default class Queue {
  /**
   * Creates an instance of Queue with the given options
   *
   * @param {string} name The unique name for this queue. This name must be
   *     unique as it's used to register sync events and store requests
   *     in IndexedDB specific to this instance. An error will be thrown if
   *     a duplicate name is detected.
   * @param {Object} [param2]
   * @param {number} [param2.maxRetentionTime = 7 days] The amount of time (in
   *     ms) a request may be retried. After this amount of time has passed,
   *     the request will be deleted and not retried.
   * @param {Object} [param2.callbacks] Callbacks to observe the lifecycle of
   *     queued requests. Use these to respond to or modify the requests
   *     during the replay process.
   * @param {function(StorableRequest):undefined} [param2.callbacks.requestWillQueue]
   *     Invoked immediately before the request is stored to IndexedDB. Use
   *     this callback to modify request data at store time.
   * @param {function(StorableRequest):undefined} [param2.callbacks.requestWillReplay]
   *     Invoked immediately before the request is re-fetched. Use this
   *     callback to modify request data at fetch time.
   * @param {function(StorableRequest):undefined} [param2.callbacks.requestDidReplay]
   *     Invoked immediately after the request has successfully re-fetched.
   * @param {function(StorableRequest):undefined} [param2.callbacks.replayDidFail]
   *     Invoked if the replay attempt failed.
   * @param {function(Array<StorableRequest>):undefined} [param2.callbacks.allRequestsDidReplay]
   *     Invoked after all requests in the queue have successfully replayed.
   */
  constructor(name, {
    maxRetentionTime = MAX_RETENTION_TIME,
    callbacks = {},
  } = {}) {
    // Ensure the store name is not already being used
    if (names.has(name)) {
      throw new WorkboxError('duplicate-queue-name', {name});
    } else {
      names.add(name);
    }

    this._name = name;
    this._callbacks = callbacks;
    this._maxRetentionTime = maxRetentionTime;

    this._addSyncListener();
  }

  /**
   * Returns an object containing the `fetchDidFail` lifecycle method. This
   * object can be used as a RequestWrapper plugin to automatically add
   * failed requests to the background sync queue to be retried later.
   *
   * @return {Object}
   */
  createPlugin() {
    return {
      fetchDidFail: ({request}) => this.addRequest(request),
    };
  }


  /**
   * Stores the passed request into IndexedDB. The database used is
   * `workbox-background-sync` and the object store name is the same as
   * the name this instance was created with (to guarantee it's unique).
   *
   * @param {Request} request The request object to store.
   */
  async addRequest(request) {
    const storableRequest = await StorableRequest.fromRequest(request);

    this._runCallback('requestWillQueue', storableRequest);

    const db = await this._getDb();
    await db.add({
      queueName: this._name,
      storableRequest: storableRequest.toObject(),
    });

    // Schedule this, but don't await it as we don't want to block subsequent
    // calls if the service worker isn't yet activated.
    this._registerSync();
  }

  /**
   * Retrieves all stored requests in IndexedDB and retries them. If the
   * queue contained requests that were successfully replayed, the
   * `allRequestsDidReplay` callback is invoked (which implies the queue is
   * now empty). If any of the requests fail, a new sync registration is
   * created to retry again later.
   *
   * @return {Promise<undefined>}
   */
  async replayRequests() {
    const storableRequestsInQueue = await this._getStorableRequestsInQueue();

    // If nothing is in the queue, return immediately and run no callbacks.
    if (!storableRequestsInQueue.length) return;

    const successfullyReplayedRequests = [];
    let allReplaysSuccessful = true;

    for (const [key, storableRequest] of storableRequestsInQueue) {
      const replaySuccessful = await this._replayRequest(key, storableRequest);
      if (replaySuccessful) {
        successfullyReplayedRequests.push(storableRequest);
      } else {
        allReplaysSuccessful = false;
      }
    }

    if (allReplaysSuccessful) {
      this._runCallback('allRequestsDidReplay', successfullyReplayedRequests);
    } else {
      this._registerSync();
    }
  }

  /**
   * Gets all requests in the object store matching this queue's name.
   *
   * @private
   * @return {Promise<Array>}
   */
  async _getStorableRequestsInQueue() {
    const db = await this._getDb();
    const storableRequests = [];

    for (const [key, entry] of (await db.getAll()).entries()) {
      if (entry.queueName == this._name) {
        // Requests older than `maxRetentionTime` should be ignored.
        const storableRequest = new StorableRequest(entry.storableRequest);

        if (Date.now() - storableRequest.timestamp > this._maxRetentionTime) {
          // No need to await this since it can happen in parallel.
          this._removeRequest(key);
          continue;
        }

        storableRequests.push([key, storableRequest]);
      }
    }

    return storableRequests;
  }

  /**
   * Gets a reference to the IndexedDB object store for queued requests.
   *
   * @private
   * @return {Promise<DBWrapper>}
   */
  _getDb() {
    return indexedDBHelper.getDB(
        DB_NAME, OBJECT_STORE_NAME, {autoIncrement: true});
  }

  /**
   * Replays a single request by attempt to re-fetch it. If the re-fetch is
   * successful
   *
   * @private
   * @param {string} key The IndexedDB object store key.
   * @param {StorableRequest} storableRequest
   * @return {Promise<boolean>}
   */
  async _replayRequest(key, storableRequest) {
    try {
      this._runCallback('requestWillReplay', storableRequest);
      await fetch(storableRequest.toRequest());
      this._runCallback('requestDidReplay', storableRequest);

      // TODO(philipwalton): in the unlikely event that the delete fails,
      // this request may be replayed again. Do we want to warn in this case?
      await this._removeRequest(key);

      return true;
    } catch (err) {
      this._runCallback('replayDidFail', storableRequest);

      return false;
    }
  }

  /**
   * Removes a request from IndexedDB for the specified key.
   *
   * @private
   * @param {string} key
   */
  async _removeRequest(key) {
    const db = await this._getDb();
    await db.delete(key);
  }

  /**
   * Runs the passed callback if it exists.
   *
   * @private
   * @param {string} name The name of the callback on this._callbacks.
   * @param {...*} args The arguments to invoke the callback with.
   */
  _runCallback(name, ...args) {
    if (typeof this._callbacks[name] == 'function') {
      this._callbacks[name].apply(null, args);
    }
  }

  /**
   * In sync-supporting browsers, this adds a listener for the sync event.
   * In non-sync-supporting browsers, this will retry the queue on service
   * worker startup.
   *
   * @private
   */
  _addSyncListener() {
    self.addEventListener('sync', (event) => {
      event.waitUntil(this.replayRequests());
    });

    // If the browser doesn't support background sync, retry
    // every time the service worker starts up as a fallback.
    if (!('sync' in registration)) {
      this.replayRequests();
    }
  }

  /**
   * Registers a sync event with a tag unique to this instance.
   *
   * @private
   */
  async _registerSync() {
    try {
      await this._waitUntilActive();
      await registration.sync.register(`${TAG_PREFIX}:${this._name}`);
    } catch (err) {
      // This means the registration failed for some reason, either because
      // the browser doesn't supported it or because the user has disabled it.
      // In either case, do nothing.
    }
  }

  /**
   * Returns a promise that resolves once the service worker is active.
   *
   * @private
   * @return {Promise}
   */
  _waitUntilActive() {
    if (self.registration.active) {
      return Promise.resolve();
    } else {
      return new Promise((resolve) => {
        self.addEventListener('activate', (event) => resolve());
      });
    }
  }
}

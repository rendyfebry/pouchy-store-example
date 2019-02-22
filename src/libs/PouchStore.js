import IPouchDB from 'pouchdb';

const ID_META_DOC = '_local/meta';
const PREFIX_META_DB = 'meta_';
const TIMEOUT_INTERNET_CHECK = 5; // seconds

/*

class options: create getter fo these:
- `this.isUseData` boolean: give false if you do not want to mirror db data to this.data. default to true.
- `this.isUseRemote` boolean: give false if you do not want to sync with remote db. default to true.
- `this.single` string: give string if you want single doc, not list. this is the ID of the doc. default to undefined.
- `this.dataDefault` optional: give array as default data, or object if single. default to `[]` if not single and `{}` if single.
- `this.sortData` optional: function that will be called whenever there is any changes to `this.data`. must be mutable to the data.

*/

export default class PouchStore {
  constructor() {
    // set default options
    if (!('isUseData' in this)) {
      this.isUseData = true;
    }
    if (!('isUseRemote' in this)) {
      this.isUseRemote = true;
    }

    this.initializeProperties();
  }

  initializeProperties() {
    // initialize in-memory data
    if (this.single) {
      this.data = this.dataDefault || {};
    } else if (this.isUseData) {
      this.data = this.dataDefault || [];
    }

    this.dataMeta = { // metadata of this store
      _id: ID_META_DOC,
      tsUpload: new Date(0).toJSON(),
      unuploadeds: {},
    };
    this.changeFromRemote = {}; // flag downloaded data from remote DB
    this.subscribers = []; // subscribers of data changes

    this.dbLocal = null;
    this.dbMeta = null;
    this.dbRemote = null;
  }

  async initialize() {
    if (this.isInitialized) return;

    if (!this.name) {
      throw new Error('store must have name');
    }

    // initalize the databases
    this.dbLocal = new PouchDB(this.name, { auto_compaction: true });
    this.dbMeta = new PouchDB(`${PREFIX_META_DB}${this.name}`, { auto_compaction: true });
    if (this.isUseRemote) {
      if (!this.urlRemote) {
        throw new Error(`store's urlRemote should not be ${this.urlRemote}`);
      }
      this.dbRemote = new PouchDB(`${this.urlRemote}${this.name}`);
    }

    // init metadata
    this.dataMeta = await this.dbMeta.getFailSafe(ID_META_DOC) || this.dataMeta;

    if (this.isUseRemote) {
      // sync data local-remote
      try {
        await checkInternet(this.urlRemote);
        await this.dbLocal.replicate.from(this.dbRemote);
        await this.upload();
      } catch (err) {
        console.error(err);
      }
    }

    // init data from PouchDB to memory
    const docs = await this.dbLocal.getDocs();
    if (this.single) {
      this.data = docs.find(doc => doc._id === this.single) || this.data;
    } else if (this.isUseData) {
      this.data = docs.filter(doc => !('deletedAt' in doc) || doc.deletedAt === null);
      this.sortData(this.data);
    }

    this.isInitialized = true;
    if (this.single || this.isUseData) {
      this.notifySubscribers(this.data);
    } else {
      this.notifySubscribers(docs);
    }

    this.watchRemote();
    this.watchLocal();
  }

  async deinitialize() {
    this.unwatchLocal();
    this.unwatchRemote();
    await this.dbLocal.close();
    await this.dbMeta.close();
    if (this.dbRemote) {
      await this.dbRemote.close();
    }
    this.initializeProperties();
    this.isInitialized = false;
  }

  updateMemory(doc) {
    if (!this.isUseData) return;

    if (this.single) {
      if (doc._id === this.single) {
        this.data = doc;
      }
    } else {
      const isDeleted = doc.deletedAt || doc._deleted;
      const index = this.data.findIndex(item => item._id === doc._id);
      if (index !== -1) {
        if (isDeleted) {
          this.data.splice(index, 1);
        } else {
          this.data[index] = doc;
        }
      } else {
        if (isDeleted) {
          // do nothing
        } else {
          this.data.push(doc);
        }
      }
      this.sortData(this.data);
    }
  }

  sortData(data) {
    // do no sorting, override this method to sort
  }

  async updateMeta(payload) {
    await this.dbMeta.update(ID_META_DOC, payload);
    Object.assign(this.dataMeta, payload);
  }

  /* watch manager for local DB and remote DB */

  watchRemote() {
    if (!this.isUseRemote) return;

    this.handlerRemoteChange = this.dbLocal.replicate.from(this.dbRemote, {
      live: true,
      retry: true,
    }).on('change', change => {
      for (let doc of change.docs) {
        this.changeFromRemote[doc._id] = true;
        this.updateMemory(doc);
      }
      this.notifySubscribers(change.docs);
    }).on('error', err => {
      console.error(`${this.name}.from`, 'error', err);
    })
  }

  unwatchRemote() {
    if (this.handlerRemoteChange) {
      this.handlerRemoteChange.cancel();
    }
  }

  watchLocal() {
    this.handlerLocalChange = this.dbLocal.changes({
      since: 'now',
      live: true,
      include_docs: true,
    }).on('change', change => {
      const doc = change.doc;
      if (this.changeFromRemote[doc._id]) {
        delete this.changeFromRemote[doc._id];
      } else {
        this.updateMemory(doc);
        this.notifySubscribers([ doc ]);
      }
    }).on('error', err => {
      console.error(`${this.name}.changes`, 'error', err);
    });
  }

  unwatchLocal() {
    if (this.handlerLocalChange) {
      this.handlerLocalChange.cancel();
    }
  }

  /* data upload (from local DB to remote DB) */

  checkIsUploaded(doc) {
    return !this.dataMeta.unuploadeds[doc._id];
  }

  async setUnuploaded(id, isUnuploaded=true) {
    const unuploadeds = {
      ...this.dataMeta.unuploadeds,
    };
    if (isUnuploaded) {
      unuploadeds[id] = true;
    } else {
      delete unuploadeds[id];
    }
    await this.updateMeta({ unuploadeds });
  }

  countUnuploadeds() {
    return Object.keys(this.dataMeta.unuploadeds || {}).length;
  }

  async upload() {
    if (!this.isUseRemote) return;

    await checkInternet(this.urlRemote);

    const unuploadeds = Object.keys(this.dataMeta.unuploadeds).map(_id => {
      return { _id };
    });
    await this.dbLocal.replicate.to(this.dbRemote);
    await this.updateMeta({
      tsUpload: new Date().toJSON(),
      unuploadeds: {},
    });
    this.notifySubscribers(unuploadeds);
  }

  /* manipulation of array data (non-single) */

  async addItem(payload, user=null) {
    const id = this.dbLocal.createId();
    await this.addItemWithId(id, payload, user);
  }

  async addItemWithId(id, payload, user=null) {
    const now = new Date().toJSON();
    await this.setUnuploaded(id);
    await this.dbLocal.put({
      ...payload,
      _id: id,
      createdAt: now,
      createdBy: user,
      deletedAt: null,
    });
  }

  async editItem(id, payload, user=null) {
    const now = new Date().toJSON();
    const doc = await this.dbLocal.getFailSafe(id);
    if (!doc) return;

    await this.setUnuploaded(id);
    await this.dbLocal.put({
      ...doc,
      ...payload,
      updatedAt: now,
      updatedBy: user,
    });
  }

  async deleteItem(id, user=null) {
    const now = new Date().toJSON();
    const doc = await this.dbLocal.getFailSafe(id);
    if (!doc) return;

    const isRealDelete = doc.deletedAt || doc.createdAt > this.dataMeta.tsUpload;
    if (isRealDelete) {
      await this.setUnuploaded(id, false);
      await this.dbLocal.remove(doc);
    } else {
      await this.setUnuploaded(id);
      await this.dbLocal.put({
        ...doc,
        deletedAt: now,
        deletedBy: user,
      });
    }
  }

  /* manipulation of single data (non-array) */

  async editSingle(payload) {
    const doc = await this.dbLocal.getFailSafe(this.single) || { _id: this.single };
    await this.setUnuploaded(doc._id);
    await this.dbLocal.put({
      ...doc,
      ...payload,
    });
  }

  async deleteSingle() {
    const doc = await this.dbLocal.getFailSafe(this.single) || { _id: this.single };
    const payload = {};
    if (doc._rev) {
      payload._rev = doc._rev;
      Object.assign(payload, this.dataDefault || {});
    }
    await this.setUnuploaded(doc._id);
    await this.dbLocal.put({
      _id: doc._id,
      ...payload,
    });
  }

  /* subscription manager */

  subscribe(subscriber) {
    const index = this.subscribers.findIndex(item => item === subscriber);
    if (index !== -1) return;

    this.subscribers.push(subscriber);
    return () => this.unsubscribe(subscriber);
  }

  unsubscribe(subscriber) {
    const index = this.subscribers.findIndex(item => item === subscriber);
    if (index === -1) return;

    this.subscribers.splice(index, 1);
  }

  notifySubscribers(docs) {
    if (!this.isInitialized) return;

    if (this.isUseData) {
      // create new array/object reference
      if (this.single) {
        this.data = { ...this.data };
      } else {
        this.data = Array.from(this.data);
      }
    }
    for (let subscriber of this.subscribers) {
      try {
        subscriber(docs);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

export class PouchDB extends IPouchDB {
  async getFailSafe(id) {
    try {
      const doc = await this.get(id);
      return doc;
    } catch (err) {
      if (err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async update(id, obj) {
    const doc = await this.getFailSafe(id) || { _id: id };
    Object.assign(doc, obj);
    const info = await this.put(doc);
    return info;
  }

  createId() {
    let id = (new Date()).getTime().toString(16);
    while (id.length < 32) {
      id += Math.random().toString(16).split('.').pop();
    }
    id = id.substr(0, 32);
    id = id.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, '$1-$2-$3-$4-$5');
    return id;
  }

  async getDocs() {
    const result = await this.allDocs({
      include_docs: true,
    });
    const docs = result.rows.map(row => row.doc);
    return docs;
  }
}

export const checkInternet = (url) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('No internet connection'));
    }, TIMEOUT_INTERNET_CHECK*1000);

    fetch(url, { method: 'HEAD' }).then(() => {
      clearTimeout(timer);
      resolve(true);
    }).catch(() => {
      reject(new Error('No internet connection'));
    });
  });
}

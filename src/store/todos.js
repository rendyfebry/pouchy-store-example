import PouchStore from '@/libs/PouchStore';
import config from '@/config';

class TodosStore extends PouchStore {
  get name() {
    return this._name;
  }

  setName(userId) {
    this._name = `todos_${userId}`;
  }

  get urlRemote() {
    return config.couchDBUrl;
  }

  sortData(data) {
    data.sort((one, two) => {
      const oneTs = one.createdAt;
      const twoTs = two.createdAt;
      if (oneTs > twoTs) return -1;
      if (oneTs < twoTs) return 1;
      return 0;
    });
  }
}

export default new TodosStore();

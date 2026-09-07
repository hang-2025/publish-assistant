import { taskFromLegacyRecord } from '../domain/task.mjs';

/** Adapter around the existing JSON TaskStore; it does not change stored data. */
export class TaskRepository {
  constructor(store) { this.store = store; }
  async getById(id) { return this.store.getTask(id); }
  async listLegacy() { return this.store.listTasks(); }
  async list() { return (await this.store.listTasks()).map(taskFromLegacyRecord); }
  async remove(id) { return this.store.removeTask(id); }
}

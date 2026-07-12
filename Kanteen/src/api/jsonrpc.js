// Thin Kanboard JSON-RPC User API client.
//
// Auth: HTTP Basic with `username:<Personal Access Token>`. Because the PWA is
// served from the Kanboard origin, requests are same-origin (no CORS) and never
// leave the LAN.

import { basicAuth } from '../util/auth.js';

export class RpcError extends Error {
  constructor(message, { code = null, data = null, http = null } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.http = http;
  }
}

function endpointFor(serverRoot) {
  const root = (serverRoot || '').replace(/\/+$/, '');
  return `${root}/jsonrpc.php`;
}

export class KanboardClient {
  constructor({ serverRoot, username, pat }) {
    this.serverRoot = serverRoot;
    this.username = username;
    this.pat = pat;
    this._id = 0;
  }

  get authHeader() {
    return basicAuth(this.username, this.pat);
  }

  async call(method, params = {}, { signal } = {}) {
    this._id += 1;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      id: this._id,
      params,
    });

    let res;
    try {
      res = await fetch(endpointFor(this.serverRoot), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
        },
        body,
        signal,
        // Same-origin in production; credentials not needed (we use Basic auth).
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e) {
      // Network failure = unreachable server (offline / off-LAN).
      throw new RpcError(`Network error: ${e.message}`, { code: 'NETWORK' });
    }

    if (res.status === 401) {
      throw new RpcError('Authentication failed (check username / token).', {
        http: 401,
      });
    }
    if (!res.ok) {
      throw new RpcError(`HTTP ${res.status}`, { http: res.status });
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new RpcError('Invalid JSON-RPC response', { http: res.status });
    }

    if (json.error) {
      throw new RpcError(json.error.message || 'RPC error', {
        code: json.error.code,
        data: json.error.data,
      });
    }
    return json.result;
  }

  // --- Convenience wrappers (User API procedures) ---

  getMe() {
    return this.call('getMe');
  }

  getVersion() {
    return this.call('getVersion');
  }

  getMyProjectsList() {
    return this.call('getMyProjectsList');
  }

  getBoard(projectId) {
    return this.call('getBoard', { project_id: Number(projectId) });
  }

  getTask(taskId) {
    return this.call('getTask', { task_id: Number(taskId) });
  }

  // Look up a task by its client-set reference within a project. Used to make
  // offline task creation idempotent: if a queued create is replayed (retry or
  // backup restore), we adopt the existing task instead of duplicating it.
  getTaskByReference(projectId, reference) {
    return this.call('getTaskByReference', {
      project_id: Number(projectId),
      reference: String(reference),
    });
  }

  createTask(params) {
    return this.call('createTask', params);
  }

  updateTask(params) {
    return this.call('updateTask', params);
  }

  moveTaskPosition({ projectId, taskId, columnId, position, swimlaneId }) {
    return this.call('moveTaskPosition', {
      project_id: Number(projectId),
      task_id: Number(taskId),
      column_id: Number(columnId),
      position: Number(position),
      swimlane_id: Number(swimlaneId),
    });
  }

  removeTask(taskId) {
    return this.call('removeTask', { task_id: Number(taskId) });
  }

  createComment({ taskId, userId, content }) {
    return this.call('createComment', {
      task_id: Number(taskId),
      user_id: Number(userId),
      content,
    });
  }

  getAllSubtasks(taskId) {
    return this.call('getAllSubtasks', { task_id: Number(taskId) });
  }

  createSubtask({ taskId, title }) {
    return this.call('createSubtask', { task_id: Number(taskId), title });
  }

  updateSubtask({ id, taskId, status, title }) {
    const params = { id: Number(id), task_id: Number(taskId) };
    if (status !== undefined) params.status = Number(status);
    if (title !== undefined) params.title = title;
    return this.call('updateSubtask', params);
  }

  removeSubtask(id) {
    return this.call('removeSubtask', { subtask_id: Number(id) });
  }

  getAllComments(taskId) {
    return this.call('getAllComments', { task_id: Number(taskId) });
  }

  updateComment({ id, content }) {
    return this.call('updateComment', { id: Number(id), content });
  }

  removeComment(id) {
    return this.call('removeComment', { comment_id: Number(id) });
  }

  closeTask(taskId) {
    return this.call('closeTask', { task_id: Number(taskId) });
  }

  openTask(taskId) {
    return this.call('openTask', { task_id: Number(taskId) });
  }

  moveTaskToProject({ projectId, taskId, swimlaneId, columnId }) {
    return this.call('moveTaskToProject', {
      project_id: Number(projectId),
      task_id: Number(taskId),
      swimlane_id: Number(swimlaneId),
      column_id: Number(columnId),
    });
  }

  getProjectUsers(projectId) {
    return this.call('getProjectUsers', { project_id: Number(projectId) });
  }

  getAllUsers() {
    return this.call('getAllUsers');
  }

  getAllCategories(projectId) {
    return this.call('getAllCategories', { project_id: Number(projectId) });
  }

  createCategory({ projectId, name, colorId = null }) {
    const params = { project_id: Number(projectId), name };
    if (colorId) params.color_id = colorId;
    return this.call('createCategory', params);
  }

  updateCategory({ id, name, colorId }) {
    const params = { id: Number(id) };
    if (name !== undefined) params.name = name;
    if (colorId !== undefined) params.color_id = colorId;
    return this.call('updateCategory', params);
  }

  removeCategory(id) {
    return this.call('removeCategory', { category_id: Number(id) });
  }

  createProject({ name }) {
    return this.call('createProject', { name });
  }

  createPrivateProject({ name }) {
    return this.call('createPrivateProject', { name });
  }

  getProjectById(projectId) {
    return this.call('getProjectById', { project_id: Number(projectId) });
  }

  updateProject({ id, projectId, name, is_private, description }) {
    const params = { id: Number(id), project_id: Number(projectId), name };
    if (is_private !== undefined) params.is_private = is_private ? 1 : 0;
    if (description !== undefined) params.description = description;
    return this.call('updateProject', params);
  }

  removeProject(id) {
    return this.call('removeProject', { project_id: Number(id) });
  }

  getColumns(projectId) {
    return this.call('getColumns', { project_id: Number(projectId) });
  }

  addColumn({ projectId, title, taskLimit = 0 }) {
    return this.call('addColumn', {
      project_id: Number(projectId),
      title,
      task_limit: Number(taskLimit),
    });
  }

  updateColumn({ id, title, taskLimit = 0 }) {
    return this.call('updateColumn', {
      column_id: Number(id),
      title,
      task_limit: Number(taskLimit),
    });
  }

  removeColumn(id) {
    return this.call('removeColumn', { column_id: Number(id) });
  }

  getActiveSwimlanes(projectId) {
    return this.call('getActiveSwimlanes', { project_id: Number(projectId) });
  }

  addSwimlane({ projectId, name }) {
    return this.call('addSwimlane', { project_id: Number(projectId), name });
  }

  updateSwimlane({ id, projectId, name }) {
    return this.call('updateSwimlane', {
      project_id: Number(projectId),
      swimlane_id: Number(id),
      name,
    });
  }

  removeSwimlane({ projectId, id }) {
    return this.call('removeSwimlane', {
      project_id: Number(projectId),
      swimlane_id: Number(id),
    });
  }

  // --- File attachments ---
  // getAllTaskFiles(task_id) — returns metadata only (id, name, is_image,
  // size, …); there is no content-embedding param (passing one yields
  // "Invalid params: Too many arguments"). Fetch bytes via downloadTaskFile.
  getAllTaskFiles(taskId) {
    return this.call('getAllTaskFiles', {
      task_id: Number(taskId),
    });
  }

  // Returns file metadata (id, name, path, is_image, …). Does NOT include content.
  getTaskFile(fileId) {
    return this.call('getTaskFile', { file_id: Number(fileId) });
  }

  // Fetches a single file's content as a base64-encoded string.
  downloadTaskFile(fileId) {
    return this.call('downloadTaskFile', { file_id: Number(fileId) });
  }

  // Upload a file. `base64` is the file content without the data: URL prefix.
  // Returns the new file's server id (string of digits).
  // Pass `onUploadProgress(percent)` to receive 0-100 upload progress via XHR.
  createTaskFile({ projectId, taskId, filename, base64, onUploadProgress }) {
    const params = {
      project_id: Number(projectId),
      task_id: Number(taskId),
      filename: String(filename),
      blob: String(base64),
    };
    return onUploadProgress
      ? this.callWithProgress('createTaskFile', params, onUploadProgress)
      : this.call('createTaskFile', params);
  }

  removeTaskFile(fileId) {
    return this.call('removeTaskFile', { file_id: Number(fileId) });
  }

  // --- Internal task-to-task links ---

  getAllLinks() {
    return this.call('getAllLinks');
  }

  getAllTaskLinks(taskId) {
    return this.call('getAllTaskLinks', { task_id: Number(taskId) });
  }

  createTaskLink(taskId, oppositeTaskId, linkId) {
    return this.call('createTaskLink', {
      task_id: Number(taskId),
      opposite_task_id: Number(oppositeTaskId),
      link_id: Number(linkId),
    });
  }

  removeTaskLink(taskLinkId) {
    return this.call('removeTaskLink', { task_link_id: Number(taskLinkId) });
  }

  // --- External (URL) links ---

  getAllExternalTaskLinks(taskId) {
    return this.call('getAllExternalTaskLinks', { task_id: Number(taskId) });
  }

  createExternalTaskLink({ taskId, url, title }) {
    return this.call('createExternalTaskLink', {
      task_id: Number(taskId),
      url: String(url),
      title: title ? String(title) : '',
      dependency: 1,
      type: 'weblink',
    });
  }

  removeExternalTaskLink(taskId, linkId) {
    return this.call('removeExternalTaskLink', {
      task_id: Number(taskId),
      link_id: Number(linkId),
    });
  }

  // --- Activity feed ---

  getProjectActivity(projectId) {
    return this.call('getProjectActivity', { project_id: Number(projectId) });
  }

  // Like call() but uses XHR so we can track upload progress (fetch has no
  // upload-progress API). Used only for large file uploads.
  callWithProgress(method, params, onUploadProgress) {
    this._id += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', method, id: this._id, params });
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpointFor(this.serverRoot));
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Authorization', this.authHeader);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onUploadProgress(Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status === 401) { reject(new RpcError('Authentication failed.', { http: 401 })); return; }
        if (xhr.status < 200 || xhr.status >= 300) { reject(new RpcError(`HTTP ${xhr.status}`, { http: xhr.status })); return; }
        let json;
        try { json = JSON.parse(xhr.responseText); } catch {
          reject(new RpcError('Invalid JSON-RPC response', { http: xhr.status })); return;
        }
        if (json.error) { reject(new RpcError(json.error.message || 'RPC error', { code: json.error.code, data: json.error.data })); return; }
        resolve(json.result);
      });
      xhr.addEventListener('error', () => reject(new RpcError('Network error during upload', { code: 'NETWORK' })));
      xhr.send(body);
    });
  }
}

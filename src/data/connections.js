import { githubConnectionRequest } from './agent.js';
export const githubConnections = {
  status: () => githubConnectionRequest('GET', ''),
  configure: setup => githubConnectionRequest('PUT', '/setup', setup),
  start: () => githubConnectionRequest('POST', '/start', { consent: true }),
  poll: id => githubConnectionRequest('POST', '/poll', { id }),
  cancel: id => githubConnectionRequest('POST', '/cancel', { id }),
  disconnect: () => githubConnectionRequest('POST', '/disconnect', { confirm: true }),
  installations: () => githubConnectionRequest('GET', '/installations'),
  repositories: (installation, page = 1) => githubConnectionRequest('GET', `/repositories?installation=${encodeURIComponent(installation)}&page=${page}`),
  link: input => githubConnectionRequest('PUT', '/project', input),
  unlink: slug => githubConnectionRequest('DELETE', '/project/' + encodeURIComponent(slug)),
};

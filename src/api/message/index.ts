import {
  messageList,
  messageCreate,
  messageGet,
  messageThread,
  messageReply,
  messageMarkRead,
  messagePatch,
  messageDelete,
  messageUnread,
} from './messageEndpoints';
import {
  groupCreate,
  groupMembersList,
  groupMembersAdd,
  groupMemberRemove,
  groupResync,
} from './groupEndpoints';

/** CRM internal-messaging routes (admin ↔ guard/client threads + groups). */
export default (app) => {
  app.get('/tenant/:tenantId/message-unread', messageUnread);
  app.get('/tenant/:tenantId/message', messageList);
  app.post('/tenant/:tenantId/message', messageCreate);
  // Group routes are registered BEFORE the /:conversationId param routes so
  // "groups" is never captured as a conversationId.
  app.post('/tenant/:tenantId/message/groups', groupCreate);
  app.get('/tenant/:tenantId/message/groups/:conversationId/members', groupMembersList);
  app.post('/tenant/:tenantId/message/groups/:conversationId/members', groupMembersAdd);
  app.delete('/tenant/:tenantId/message/groups/:conversationId/members/:userId', groupMemberRemove);
  app.post('/tenant/:tenantId/message/groups/:conversationId/resync', groupResync);
  app.get('/tenant/:tenantId/message/:conversationId', messageGet);
  app.get('/tenant/:tenantId/message/:conversationId/messages', messageThread);
  app.post('/tenant/:tenantId/message/:conversationId/messages', messageReply);
  app.post('/tenant/:tenantId/message/:conversationId/read', messageMarkRead);
  app.patch('/tenant/:tenantId/message/:conversationId', messagePatch);
  app.delete('/tenant/:tenantId/message/:conversationId', messageDelete);
};

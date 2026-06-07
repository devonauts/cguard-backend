import {
  messageList,
  messageCreate,
  messageGet,
  messageThread,
  messageReply,
  messageMarkRead,
  messagePatch,
  messageUnread,
} from './messageEndpoints';

/** CRM internal-messaging routes (admin ↔ guard/client threads). */
export default (app) => {
  app.get('/tenant/:tenantId/message-unread', messageUnread);
  app.get('/tenant/:tenantId/message', messageList);
  app.post('/tenant/:tenantId/message', messageCreate);
  app.get('/tenant/:tenantId/message/:conversationId', messageGet);
  app.get('/tenant/:tenantId/message/:conversationId/messages', messageThread);
  app.post('/tenant/:tenantId/message/:conversationId/messages', messageReply);
  app.post('/tenant/:tenantId/message/:conversationId/read', messageMarkRead);
  app.patch('/tenant/:tenantId/message/:conversationId', messagePatch);
};

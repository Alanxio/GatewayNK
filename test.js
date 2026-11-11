import { saveInteraction } from './src/controller/notification.controller.js';
import db from './src/db/db.js';

const fakeReq = {
  body: {
    title: 'TestUser',
    message: 'Hello World',
    date: '2026-07-26',
    time: '2026-07-26 13:14:00',
    chat_id: '1234567890@c.us',
    sender_chat_id: '1234567890@c.us',
    whatsapp_msg_id: 'false_123456',
    from_me: 0,
  },
};

const mockRes = {
  statusCode: 200,
  _json: null,
  status(code) { this.statusCode = code; return this; },
  json(data) { this._json = data; console.log("Response:", code, data); },
};

saveInteraction(fakeReq, mockRes, (err) => console.error("Next called with error:", err))
  .then(res => console.log("Done:", res))
  .catch(err => console.error("Caught:", err));

import { saveInteraction } from './src/controller/notification.controller.js';
import db from './db/db.js';

const fakeReq = {
  body: {
    title: 'Grupo sin nombre:Daniel CaraLowtapeAudio (El Puto Pesao De Los Cojones)',
    message: 'Mira el legends que está al lado',
    date: '2026-08-01',
    time: '2026-08-01 09:05:15',
    chat_id: '120363422504602340@g.us',
    sender_chat_id: '57273439256658@lid',
    whatsapp_msg_id: null,
    from_me: 0,
  },
};

const mockRes = {
  statusCode: 200,
  _json: null,
  status(code) { this.statusCode = code; return this; },
  json(data) { this._json = data; console.log("Response:", this.statusCode, data); },
};

saveInteraction(fakeReq, mockRes, (err) => console.error("Next called with error:", err))
  .then(res => console.log("Done:", res))
  .catch(err => console.error("Caught:", err));

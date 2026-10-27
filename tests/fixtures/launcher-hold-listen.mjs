import { Server } from 'node:net';

// Keep the real backend alive after its lock, database and migration state are ready.
Server.prototype.listen = function () {
  setInterval(() => {}, 1000);
  process.send('listen-held');
  return this;
};

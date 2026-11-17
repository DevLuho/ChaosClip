// Envoi vers ChaosBooru (Chaos Tools) : rempli au lot 7.
module.exports = {
  status: async () => ({ connected: false }),
  setToken: async () => { throw new Error('Pas encore disponible'); },
  catalogue: async () => ({ items: [] }),
  send: async () => { throw new Error('Pas encore disponible'); },
};

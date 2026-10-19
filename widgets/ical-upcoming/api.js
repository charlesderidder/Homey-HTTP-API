'use strict';

module.exports = {
  async getUpcomingEvents({ homey, query }) {
    const daysAhead = Number(query.daysAhead || 3);
    return homey.app.getUpcomingICalEvents(daysAhead);
  },

  async syncCalendars({ homey }) {
    return homey.app.syncCalendars();
  },
};

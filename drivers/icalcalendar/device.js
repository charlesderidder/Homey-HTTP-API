'use strict';

const Homey = require('homey');

class ICalCalendarDevice extends Homey.Device {
  async onInit() {
    await this.updateEventCount();
    this.homey.settings.on('set', (key) => {
      if (key === 'icalEvents') {
        this.updateEventCount().catch((error) => this.error('Could not update the synchronized event count', error));
      }
    });
  }

  async updateEventCount() {
    const events = this.homey.settings.get('icalEvents');
    const hasUpcomingEvents = Array.isArray(events)
      && events.some((event) => typeof event.end === 'number' && event.end > Date.now());
    await this.setCapabilityValue('alarm_generic', hasUpcomingEvents);
  }
}

module.exports = ICalCalendarDevice;

'use strict';

const Homey = require('homey');

class ICalCalendarDriver extends Homey.Driver {
  async onPairListDevices() {
    return [{
      name: 'iCal Calendar overview',
      data: { id: 'ical-calendar-overview' },
    }];
  }
}

module.exports = ICalCalendarDriver;

interface TestEmailRequest {
  homey: {
    app: {
      sendTestEmail(): Promise<void>;
    };
  };
}

interface SyncCalendarsRequest {
  homey: {
    app: {
      syncCalendars(): Promise<{
        events: number;
        added: Array<{ calendar: string; title: string; start: string }>;
        changed: Array<{ calendar: string; title: string; start: string }>;
        failedCalendars: string[];
        failures: Array<{ calendar: string; error: string }>;
      }>;
    };
  };
}

export async function testEmail({ homey }: TestEmailRequest): Promise<{ success: true }> {
  await homey.app.sendTestEmail();
  return { success: true };
}

export async function syncCalendars(
  { homey }: SyncCalendarsRequest,
): Promise<{
  events: number;
  added: Array<{ calendar: string; title: string; start: string }>;
  changed: Array<{ calendar: string; title: string; start: string }>;
  failedCalendars: string[];
  failures: Array<{ calendar: string; error: string }>;
}> {
  return homey.app.syncCalendars();
}

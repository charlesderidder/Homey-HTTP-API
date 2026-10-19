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
      syncCalendars(): Promise<{ events: number; failedCalendars: string[] }>;
    };
  };
}

export async function testEmail({ homey }: TestEmailRequest): Promise<{ success: true }> {
  await homey.app.sendTestEmail();
  return { success: true };
}

export async function syncCalendars(
  { homey }: SyncCalendarsRequest,
): Promise<{ events: number; failedCalendars: string[] }> {
  return homey.app.syncCalendars();
}

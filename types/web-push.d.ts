declare module 'web-push' {
  export type PushSubscription = {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };

  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string,
  ): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: {
      agent?: import('node:https').Agent;
      timeout?: number;
    },
  ): Promise<unknown>;

  const webPush: {
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
  };

  export default webPush;
}

declare module 'server-only';

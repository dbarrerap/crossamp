export interface CrossampApi {
  platform: NodeJS.Platform | string;
}

declare global {
  interface Window {
    crossamp?: CrossampApi;
  }
}

export {};

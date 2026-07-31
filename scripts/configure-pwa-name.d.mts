export interface ConfigurePwaNameOptions {
  distDir: string;
  name: string;
  id?: string;
  startUrl?: string;
  scope?: string;
}

export function configurePwaName(options: ConfigurePwaNameOptions): Promise<void>;

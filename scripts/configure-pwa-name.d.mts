export interface ConfigurePwaNameOptions {
  distDir: string;
  name: string;
  id?: string;
}

export function configurePwaName(options: ConfigurePwaNameOptions): Promise<void>;

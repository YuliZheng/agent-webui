export interface PublishedFrontendBuild {
  liveDir: string;
  referenceCount: number;
}

export interface ValidatedFrontendBuild {
  html: string;
  localReferences: string[];
}

export function validateFrontendBuild(stagedDir: string): Promise<ValidatedFrontendBuild>;

export function publishFrontendBuild(options: {
  stagedDir: string;
  liveDir?: string;
}): Promise<PublishedFrontendBuild>;

export function buildAndPublishFrontend(): Promise<void>;

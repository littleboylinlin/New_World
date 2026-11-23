export function desktopFeedbackPlatform(platform: string): string | undefined
export function feedbackLinks(
  version: string,
  platform: string,
  t: (key: string, values: string[]) => string,
): { github: string; email: string }

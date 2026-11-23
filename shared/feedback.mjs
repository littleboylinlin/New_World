export function desktopFeedbackPlatform(platform) {
  switch (platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
  }
}

export function feedbackLinks(version, platform, t) {
  const fields = new URLSearchParams({ version, platform })
  const subject = encodeURIComponent(t('feedback.emailSubject', [version]))
  const body = encodeURIComponent(t('feedback.emailBody', [version, platform]))
  return {
    github: `https://github.com/littleboylinlin/New_World/issues/new/choose?${fields}`,
    email: `mailto:feedback@writenewworld.com?subject=${subject}&body=${body}`,
  }
}

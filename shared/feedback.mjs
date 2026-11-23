export function desktopFeedbackPlatform(platform) {
  switch (platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
  }
}

export function feedbackLinks(version, platform, t) {
  const issueForm = 'https://github.com/littleboylinlin/New_World/issues/new'
  const fields = new URLSearchParams({ version, platform })
  const subject = encodeURIComponent(t('feedback.emailSubject', [version]))
  const body = encodeURIComponent(t('feedback.emailBody', [version, platform]))
  return {
    bug: `${issueForm}?template=bug.yml&${fields}`,
    feature: `${issueForm}?template=feature.yml&${fields}`,
    email: `mailto:feedback@writenewworld.com?subject=${subject}&body=${body}`,
  }
}

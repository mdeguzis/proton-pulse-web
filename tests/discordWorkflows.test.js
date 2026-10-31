/**
 * Every Discord notification workflow must fail its run when the webhook
 * rejects the post (#584). With a bare `curl -s`, a deleted webhook answers
 * 404 and the run still goes green, which is how DISCORD_WEBHOOK_RELEASES sat
 * dead for three months without anyone noticing.
 */
const fs = require('fs');
const path = require('path');

const WF_DIR = path.join(__dirname, '..', '.github', 'workflows');
const discordWorkflows = fs.readdirSync(WF_DIR).filter((f) => /^discord-.*\.ya?ml$/.test(f));

// Lines that POST to a webhook URL held in WEBHOOK_URL.
const webhookCurls = (yaml) =>
  yaml.split('\n').filter((line) => /\bcurl\b/.test(line) && line.includes('$WEBHOOK_URL'));

describe('Discord webhook posts fail loudly (#584)', () => {
  test('the workflow set is the one this test was written for', () => {
    // A new discord-*.yml is fine; this just proves the glob still matches.
    expect(discordWorkflows).toEqual(expect.arrayContaining([
      'discord-backups.yml',
      'discord-incidents.yml',
      'discord-issues.yml',
      'discord-pull-requests.yml',
      'discord-releases.yml',
    ]));
  });

  test.each(discordWorkflows)('%s: every webhook curl fails on an HTTP error', (file) => {
    const yaml = fs.readFileSync(path.join(WF_DIR, file), 'utf8');
    for (const line of webhookCurls(yaml)) {
      expect(line).toMatch(/--fail-with-body|\s-f\b|--fail\b/);
      // -S keeps the error visible even though -s hides the progress meter.
      expect(line).toMatch(/\s-sS\b|--show-error/);
      // The response body must stay visible so the run log says why.
      expect(line).not.toMatch(/-o \/dev\/null/);
    }
  });
});

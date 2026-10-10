/**
 * The Humans of Globe pitch, from the team's sales-agent setup: an invitation to share a leadership story in an upcoming
 * global feature (print and digital), for the authentic, high-editorial-standard storytelling, the visibility among
 * decision-makers, and the peers it connects them with.
 */
export const PITCH = {
  offer: 'Humans of Globe Media Features',
  callToAction: 'Share their leadership story for an upcoming global feature',
  socialProof: ['Okba Chabbi', 'Massey Whiteknife', 'Anja Vandenbergh'],
};

export type DraftInput = { name: string; title: string; company: string };
export type Draft = { firstName: string; subject: string; body: string };

const HONORIFIC = /^(dr|mr|mrs|ms|miss|eng|engr|prof|sir|he|h\.e|sheikh|shaikh)\.?$/i;

/** "Dr. Ahmed Al Sayed" gives "Ahmed"; an empty name gives "there" (for "Hi there"). */
export function firstNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
  const first = words[0] ?? '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there';
}

/** "as Founder & CEO at Acme", "at Acme", or nothing, depending on what we know. */
function roleLine(title: string, company: string): string {
  if (title && company) return ` as ${title} at ${company}`;
  if (company) return ` at ${company}`;
  return '';
}

/**
 * The first email for a lead. Written from the lead's saved name, title and company only, in code (no AI), so every
 * draft is predictable and no personal data leaves the app. The sending tool adds the sender's signature.
 */
export function draftEmail(p: DraftInput): Draft {
  const firstName = firstNameOf(p.name);
  const subject = p.company ? `Featuring ${p.company}'s leadership story` : 'An invitation to share your leadership story';
  const body = [
    `Hi ${firstName},`,
    '',
    `I'm reaching out from Humans of Globe. We're putting together our next global feature on leaders who are building something worth talking about, and your work${roleLine(p.title, p.company)} stood out.`,
    '',
    'Humans of Globe publishes in-depth leadership stories in print and online, read by decision-makers and professionals around the world. Each feature is an interview told in your own voice and held to a high editorial standard, not a press release.',
    '',
    `Leaders such as ${PITCH.socialProof.slice(0, -1).join(', ')} and ${PITCH.socialProof[PITCH.socialProof.length - 1]} have shared their stories with us.`,
    '',
    'Would you be open to sharing yours in the upcoming edition? Reply here and I will send over the details.',
  ].join('\n');
  return { firstName, subject, body };
}

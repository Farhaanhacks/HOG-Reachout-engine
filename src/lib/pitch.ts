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

/**
 * The Apollo custom contact fields that carry each person's own email parts into the sequence. The team creates these
 * fields once in Apollo (Settings, Objects and fields, Contact), with exactly these names. The edition title and the
 * industry line change per segment, so they are fields too, never written into the template.
 */
export const CUSTOM_FIELDS = {
  subject: 'HOG Subject',
  opener: 'HOG Opener',
  unsubscribe: 'HOG Unsubscribe link',
  edition: 'HOG Edition',
  industry: 'HOG Industry',
} as const;

export type DraftInput = {
  name: string;
  title: string;
  company: string;
  /** The personal first line, when one was written. */
  opener?: string;
  /** The edition they are pitched for ("Healthcare Leaders Edition") and its industry line ("Healthcare Leaders"). */
  edition?: string;
  industryLine?: string;
};
export type Draft = { firstName: string; subject: string; body: string };

const HONORIFIC = /^(dr|mr|mrs|ms|miss|eng|engr|prof|sir|he|h\.e|sheikh|shaikh)\.?$/i;

const DEFAULT_EDITION = 'Global Leaders Edition';
const DEFAULT_INDUSTRY_LINE = 'Business Leaders';

/** The line after the opener, naming the edition and its industry line. */
function afterOpener(edition: string, industryLine: string): string {
  return `That's why I'm reaching out from Humans of Globe. We're putting together our upcoming ${edition}, a global feature on ${industryLine} who are building something worth talking about, and we'd love to include your story.`;
}

/** The fixed part of every email, after the personal opening. */
const PITCH_PARAGRAPHS = [
  'Humans of Globe publishes in-depth leadership stories in print and online, read by decision-makers and professionals around the world. Each feature is an interview told in your own voice and held to a high editorial standard, not a press release.',
  `Leaders such as ${PITCH.socialProof.slice(0, -1).join(', ')} and ${PITCH.socialProof[PITCH.socialProof.length - 1]} have shared their stories with us.`,
  'Would you be open to sharing yours in the upcoming edition? Reply here and I will send over the details.',
];

/** The last line of every email, plain-text version. */
export function unsubscribeLineText(url: string): string {
  return `If you'd rather not hear from Humans of Globe, you can unsubscribe here: ${url}`;
}

/** "Dr. Ahmed Al Sayed" gives "Ahmed"; an empty name gives "there" (for "Hi there"). */
export function firstNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
  const first = words[0] ?? '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there';
}

export function subjectFor(company: string): string {
  return company ? `Featuring ${company}'s leadership story` : 'An invitation to share your leadership story';
}

/** "as Founder & CEO at Acme", "at Acme", or nothing, depending on what we know. */
function roleLine(title: string, company: string): string {
  if (title && company) return ` as ${title} at ${company}`;
  if (company) return ` at ${company}`;
  return '';
}

/**
 * The first email for a lead, as they will read it. The personal opener (written from research, see personalize.ts)
 * comes first; everything else is the fixed pitch, assembled in code, so the AI can never change what Humans of Globe
 * offers. The sending mailbox adds the signature. Without an opener (only before personalization has run) the
 * standard opening is shown.
 */
export function draftEmail(p: DraftInput): Draft {
  const firstName = firstNameOf(p.name);
  const opener = p.opener?.trim();
  const edition = p.edition?.trim() || DEFAULT_EDITION;
  const industryLine = p.industryLine?.trim() || DEFAULT_INDUSTRY_LINE;
  const body = [
    `Hi ${firstName},`,
    '',
    opener
      ? `${opener}\n\n${afterOpener(edition, industryLine)}`
      : `I'm reaching out from Humans of Globe. We're putting together our upcoming ${edition}, a global feature on ${industryLine} who are building something worth talking about, and your work${roleLine(p.title, p.company)} stood out.`,
    '',
    PITCH_PARAGRAPHS.join('\n\n'),
  ].join('\n');
  return { firstName, subject: subjectFor(p.company), body };
}

/**
 * The email to paste into the Apollo sequence's email step, once. Each person's subject, opener, edition, industry line
 * and unsubscribe link come from their custom fields, so every email is still personal; the rest is the same fixed pitch as draftEmail.
 */
export function sequenceTemplate(): { subject: string; body: string } {
  return {
    subject: `{{${CUSTOM_FIELDS.subject}}}`,
    body: [
      'Hi {{#if first_name}}{{first_name}}{{#else}}there{{#endif}},',
      '',
      `{{${CUSTOM_FIELDS.opener}}}`,
      '',
      afterOpener(`{{${CUSTOM_FIELDS.edition}}}`, `{{${CUSTOM_FIELDS.industry}}}`),
      '',
      PITCH_PARAGRAPHS.join('\n\n'),
      '',
      unsubscribeLineText(`{{${CUSTOM_FIELDS.unsubscribe}}}`),
    ].join('\n'),
  };
}

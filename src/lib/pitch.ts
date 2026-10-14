import { BRANDS, type Brand } from './brands';

/**
 * The Cover Story invitation, the same for every brand (Humans of Globe, Gulf Icons, CIO Minds) with the brand's own name
 * and website, kept short: congratulations on a recent achievement, a shortlisting for the Cover Story Profile in a
 * special edition named for the person's field and its readership, what the feature includes, and a reply-to-hear-more close.
 *
 * A/B test: version A shows the featuring fee, version B does not, to see whether showing the price affects spam
 * placement and replies. Both versions are pasted into the same Apollo step as Test A and Test B; Apollo splits the
 * people between them, and the Results page tells them apart by whether the sent email contains the fee line.
 */

/** The same for every sender. Each sender's own name is the sending inbox's name (the HOG Sender field). */
export const SENDER = {
  designation: 'Business Development Manager',
  office: '+1 (253) 338-0280',
  whatsapp: '+1 253-338-0280',
};


export const FEE_LINE = 'Proposed Featuring Fee: USD 2500';
export type Variant = 'A' | 'B';
export const VARIANT_LABEL: Record<Variant, string> = { A: 'Version A (shows the fee)', B: 'Version B (no fee)' };

/**
 * How the email lets people opt out:
 *  - button: an HTML email ending in a real Unsubscribe button that opens the person's own signed unsubscribe page.
 *  - link: the engine's own signed unsubscribe link, written out.
 *  - apollo: Apollo adds "No longer interested in these messages? Unsubscribe" after the signature.
 *  - reply: no link at all; the person replies "unsubscribe".
 */
export type UnsubscribeStyle = 'button' | 'link' | 'apollo' | 'reply';
export const UNSUBSCRIBE_STYLES: UnsubscribeStyle[] = ['button', 'link', 'apollo', 'reply'];

/**
 * The Apollo custom contact fields that carry each person's own parts into the sequence. The team creates these fields
 * once in Apollo (Settings, Objects and fields, Contact: global, single-line text), with exactly these names.
 */
export const CUSTOM_FIELDS = {
  subject: 'HOG Subject',
  opener: 'HOG Opener',
  role: 'HOG Role',
  edition: 'HOG Edition',
  industry: 'HOG Industry',
  sender: 'HOG Sender',
  unsubscribe: 'HOG Unsubscribe link',
} as const;

/** How a custom field is written in an Apollo template: {{contact.HOG Opener}} (the form Apollo's variable picker inserts). */
export function fieldVariable(key: keyof typeof CUSTOM_FIELDS): string {
  return `{{contact.${CUSTOM_FIELDS[key]}}}`;
}

const HONORIFIC = /^(dr|mr|mrs|ms|miss|eng|engr|prof|sir|he|h\.e|sheikh|shaikh)\.?$/i;

/** "Dr. Ahmed Al Sayed" gives "Ahmed"; an empty name gives "" (the greeting then says "Sir or Madam"). */
export function firstNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
  const first = words[0] ?? '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

export function subjectFor(company: string): string {
  return company.trim() ? `Cover Story invite for ${company.trim()}` : 'Cover Story invite';
}

/** "your role as Founder & CEO at Access Dubai", for "Your recent achievement in …". */
export function roleFor(title: string, company: string): string {
  const t = title.trim();
  const c = company.trim();
  if (t && c) return `your role as ${t} at ${c}`;
  if (c) return `your work at ${c}`;
  if (t) return `your role as ${t}`;
  return 'your work';
}

/** The parts that change per person, as they go into the custom fields (or into a preview). */
export type EmailParts = { firstName: string; opener: string; role: string; edition: string };
type Bold = { bold: true; text: string };
/** A link: in HTML a clickable link, in plain text its text (mail apps turn a bare domain into a link). */
type Link = { href: string; text: string };
type Line = string | Link;
type Block = string | Bold | { list: string[] } | { lines: Line[] };

export const READERSHIP = 'We reach 620,000+ readers all over the world.';

const INCLUDES = [
  'A cover story and a full write-up on you and your company, from a short 35-minute interview',
  'Published in our digital and print edition, with your approval on the draft before it goes out',
  '5 full-page ad placements and 3 CXO Standpoint articles to use across the year',
];

/** The email as blocks, so the plain-text and HTML versions always say exactly the same thing. */
function blocks(brand: Brand, variant: Variant, p: EmailParts, senderName: string, greetingName: string): Block[] {
  const name = BRANDS[brand].label;
  return [
    `Dear ${greetingName},`,
    { bold: true, text: p.opener },
    `In recognition of ${p.role}, our editorial team at ${name} has shortlisted you for a Cover Story Profile in our upcoming special edition, "${p.edition}". ${READERSHIP}`,
    { bold: true, text: 'The feature includes:' },
    { list: INCLUDES },
    ...(variant === 'A' ? [{ bold: true, text: FEE_LINE } as Bold] : []),
    'We believe your story would be a great fit for this edition. Would you like to explore it? Simply reply to this email and I will share the full proposal.',
    { lines: ['Warm regards,', senderName, SENDER.designation, name, `Office: ${SENDER.office}`, `WhatsApp: ${SENDER.whatsapp}`, { href: `https://${BRANDS[brand].domain}`, text: BRANDS[brand].domain }] },
  ];
}

const lineText = (l: Line) => (typeof l === 'string' ? l : l.text);

function toText(list: Block[]): string {
  return list
    .map((b) => (typeof b === 'string' ? b : 'bold' in b ? b.text : 'list' in b ? b.list.map((i) => `•  ${i}`).join('\n') : b.lines.map(lineText).join('\n')))
    .join('\n\n');
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const P = 'margin:0 0 14px;';
const lineHtml = (l: Line) => (typeof l === 'string' ? escapeHtml(l) : `<a href="${escapeHtml(l.href)}" target="_blank" style="color:#1a5fb4;text-decoration:underline;">${escapeHtml(l.text)}</a>`);

function toHtml(list: Block[]): string {
  return list
    .map((b) => {
      if (typeof b === 'string') return `<p style="${P}">${escapeHtml(b)}</p>`;
      if ('bold' in b) return `<p style="${P}"><strong>${escapeHtml(b.text)}</strong></p>`;
      if ('list' in b) return `<ul style="margin:0 0 14px;padding-left:20px;">\n${b.list.map((i) => `<li style="margin:0 0 4px;">${escapeHtml(i)}</li>`).join('\n')}\n</ul>`;
      return `<p style="${P}">${b.lines.map(lineHtml).join('<br>')}</p>`;
    })
    .join('\n');
}

/** The last line of a plain-text email in the chosen style. `url` is the person's own unsubscribe link. */
export function unsubscribeLine(style: UnsubscribeStyle, url: string): string {
  if (style === 'apollo') return 'No longer interested in these messages? Unsubscribe';
  if (style === 'button') return 'No longer want these emails?  [ Unsubscribe ]';
  if (style === 'reply') return 'If you would rather not hear from us again, just reply "unsubscribe" and we will not contact you again.';
  return `If you'd rather not hear from us, you can unsubscribe here: ${url}`;
}

/**
 * The Unsubscribe button: a small, plain grey button (a loud coloured one looks like marketing to spam filters). The
 * box is drawn by the link itself, so it survives editors that strip table styling.
 */
export function unsubscribeButtonHtml(url: string): string {
  return [
    '<p style="margin:24px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#777777;">No longer want these emails?</p>',
    `<p style="margin:0;"><a href="${url}" target="_blank" style="display:inline-block;padding:8px 18px;background:#f2f3f5;border:1px solid #d5d8dc;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#333333;text-decoration:none;">Unsubscribe</a></p>`,
  ].join('\n');
}

export type DraftInput = { name: string; title: string; company: string; opener?: string; edition?: string; brand?: Brand; variant?: Variant; senderName?: string };
export type Draft = { firstName: string; subject: string; body: string };

/** The email one lead will read (plain text, without the unsubscribe line), for previews and exports. */
export function draftEmail(p: DraftInput): Draft {
  const firstName = firstNameOf(p.name);
  const parts: EmailParts = {
    firstName,
    opener: p.opener?.trim() || fallbackOpenerFor(p.company),
    role: roleFor(p.title, p.company),
    edition: p.edition?.trim() || 'Top Business Leaders to Watch',
  };
  const body = toText(blocks(p.brand ?? 'hog', p.variant ?? 'A', parts, p.senderName || '[Sender name]', firstName || 'Sir or Madam'));
  return { firstName, subject: subjectFor(p.company), body };
}

/** The first line when there is no news to congratulate them on: never wrong, since it only uses their company. */
export function fallbackOpenerFor(company: string): string {
  return company.trim() ? `Congratulations on your continued leadership at ${company.trim()}!` : 'Congratulations on your continued leadership!';
}

const TEMPLATE_PARTS: EmailParts = { firstName: '', opener: fieldVariable('opener'), role: fieldVariable('role'), edition: fieldVariable('edition') };
// The signature name is the sending inbox's own name ("John Cooper"), filled per person by the engine. Apollo's
// {{sender_first_name}} would give the Apollo user who owns the inboxes instead.
const TEMPLATE_SENDER = fieldVariable('sender');
const TEMPLATE_GREETING = '{{#if first_name}}{{first_name}}{{#else}}Sir or Madam{{#endif}}';

/** The plain-text email to paste into the brand's Apollo sequence step: version A or B, ending in the chosen opt-out. */
export function sequenceTemplate(brand: Brand = 'hog', variant: Variant = 'A', style: UnsubscribeStyle = 'button'): { subject: string; body: string } {
  const body = toText(blocks(brand, variant, TEMPLATE_PARTS, TEMPLATE_SENDER, TEMPLATE_GREETING));
  return { subject: fieldVariable('subject'), body: style === 'apollo' ? body : `${body}\n\n${unsubscribeLine(style, fieldVariable('unsubscribe'))}` };
}

/** The same email as HTML for Apollo's raw HTML editor, ending in the Unsubscribe button. */
export function sequenceTemplateHtml(brand: Brand = 'hog', variant: Variant = 'A'): string {
  return `${toHtml(blocks(brand, variant, TEMPLATE_PARTS, TEMPLATE_SENDER, TEMPLATE_GREETING))}\n${unsubscribeButtonHtml(fieldVariable('unsubscribe'))}`;
}

/**
 * The follow-up, sent the next day in the same thread (step 2 of each brand's sequence, "1 day" after step 1) to everyone
 * who has not replied or unsubscribed; Apollo stops the sequence for those who have. It is the same for versions A and B
 * and does not mention the fee, so the A/B test stays about the first email.
 */
function followUpBlocks(brand: Brand, p: Pick<EmailParts, 'role' | 'edition'>, senderName: string, greetingName: string): Block[] {
  const name = BRANDS[brand].label;
  return [
    `Dear ${greetingName},`,
    `I wanted to follow up on my note yesterday about featuring you on the cover of our upcoming special edition, "${p.edition}".`,
    `Your recent achievement in ${p.role} is exactly the kind of leadership story our readers at ${name} look for, and we would be glad to share the full Cover Story proposal with you.`,
    'Would you be open to taking a look? Simply reply to this email and I will send over the details.',
    { lines: ['Warm regards,', senderName, SENDER.designation, name] },
  ];
}

/** The follow-up for the brand's sequence step 2: plain text, ending in the chosen opt-out. Sent as a reply, so no subject. */
export function followUpTemplate(brand: Brand = 'hog', style: UnsubscribeStyle = 'button'): { body: string } {
  const body = toText(followUpBlocks(brand, TEMPLATE_PARTS, TEMPLATE_SENDER, TEMPLATE_GREETING));
  return { body: style === 'apollo' ? body : `${body}\n\n${unsubscribeLine(style, fieldVariable('unsubscribe'))}` };
}

/** The follow-up as HTML for Apollo's raw HTML editor, ending in the Unsubscribe button. */
export function followUpTemplateHtml(brand: Brand = 'hog'): string {
  return `${toHtml(followUpBlocks(brand, TEMPLATE_PARTS, TEMPLATE_SENDER, TEMPLATE_GREETING))}\n${unsubscribeButtonHtml(fieldVariable('unsubscribe'))}`;
}

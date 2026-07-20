/**
 * The ONE way to label a client in anything an operator or customer reads.
 *
 * A `clientAccount` carries two identities and they are trivially confused:
 *   - `commercialName` → the COMPANY ("Comercial Ecuador S.A."). Canonical.
 *   - `name` + `lastName` → the PERSON. A denormalized cache of the linked user
 *     (see the model comments), i.e. the legal representative / contact.
 *
 * Everywhere the UI says "Cliente" it means the company. Endpoints that built a
 * label from `name`/`lastName` put a person's name in front of operators who
 * were reassigning a vigilante or reading a report — unrecognisable, since
 * nobody identifies a client by their legal rep.
 *
 * Falls back to the person only when there is genuinely no commercialName on
 * record, because a blank label is worse than an imperfect one.
 *
 * Companion to the frontend's src/lib/clientName.ts — keep the two in step.
 */

const trim = (v: any) => (v == null ? '' : String(v).trim());

/** Canonical business name for a client. Never returns null. */
export function businessNameOf(c: any): string {
  if (!c) return '';
  const commercial = trim(c.commercialName) || trim(c.companyName);
  if (commercial) return commercial;
  const full = [trim(c.name), trim(c.lastName)].filter(Boolean).join(' ');
  return full || trim(c.name);
}

/**
 * Columns every query must select for businessNameOf() to work. Selecting only
 * ['id','name'] is what silently reintroduces this bug — the fallback then has
 * nothing better to return.
 */
export const CLIENT_LABEL_ATTRIBUTES = ['id', 'name', 'lastName', 'commercialName'];

/** SQL fragment for raw queries. `alias` is the clientAccount table alias. */
export const clientLabelSql = (alias: string) =>
  `COALESCE(NULLIF(TRIM(${alias}.commercialName), ''), TRIM(CONCAT(COALESCE(${alias}.name,''),' ',COALESCE(${alias}.lastName,''))))`;

export default businessNameOf;

import { KindProfile, SnDiagnostic } from './types';
import { scanDirectChildElements } from '../parseSnXml';

/**
 * Studio Git table-schema exports: a `<database>` root whose child is the table's
 * `type="collection"` element, with one nested `<element>` per column.
 *
 * Unlike every other kind these carry no `action=` rows and no `sys_id`, so the
 * table name and label are attributes rather than fields and the shape has to be
 * recognized from the root element. Any in-scope XML on a `<database>` root is
 * claimed here, since Studio exports are the only source of that root in an app
 * repo; the rules below then report a root that holds no named table element.
 * The basename is the table name by convention only and is not validated
 * against the content — these files stay valid when renamed.
 */
export const dictionaryExport: KindProfile = {
  id: 'dictionary_export',
  label: 'Dictionary export',
  lintScripts: false,
  lintJson: false,

  matches(doc) {
    return doc.rootName?.toLowerCase() === 'database';
  },

  validate(doc) {
    const diagnostics: SnDiagnostic[] = [];

    if (!findTableElement(doc.text)) {
      diagnostics.push({
        message:
          'Dictionary export: expected a child <element name="…"> naming the table.',
        severity: 'error',
        line: 0,
        character: 0,
        code: 'dictionary-no-table-element'
      });
    }

    if (doc.rows.length > 0) {
      diagnostics.push({
        message:
          'Dictionary export mixes schema elements with action= record rows; export one or the other.',
        severity: 'warning',
        line: doc.rows[0].line,
        character: doc.rows[0].character,
        code: 'dictionary-unexpected-rows'
      });
    }

    return diagnostics;
  }
};

/** True when the root has an `<element>` child carrying a `name` attribute. */
function findTableElement(text: string): boolean {
  return scanDirectChildElements(text).some(
    (child) =>
      child.name.toLowerCase() === 'element' &&
      /\bname\s*=\s*(?:"[^"]+"|'[^']+')/i.test(text.slice(child.start, child.bodyStart))
  );
}

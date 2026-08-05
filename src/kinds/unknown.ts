import { KindProfile } from './types';

/**
 * Catch-all for well-formed XML that is not a known ServiceNow kind.
 */
export const unknownSnXml: KindProfile = {
  id: 'unknown_sn_xml',
  label: 'Unknown SN XML',
  lintScripts: false,
  lintJson: false,

  matches() {
    return true;
  },

  validate(doc) {
    return [
      {
        message:
          'XML is well-formed but did not match a known ServiceNow document kind (scoped app record update, data export, or customer update).',
        severity: 'warning',
        line: 0,
        character: 0,
        code: 'unknown-kind'
      }
    ];
  }
};

/**
 * Name pattern generation for Arabic personal name search
 */

export interface NameFormData {
  id: string;
  kunyas: string[];           // Max 2
  nasab: string;              // e.g., "معمر بن أحمد بن زياد"
  nisbas: string[];           // Unlimited
  shuhra: string;             // Optional
  allowRareKunyaNisba: boolean;    // "Include kunya + nisba"
  allowKunyaNasab: boolean;        // "Include kunya + 1st nasab"
  allowOneNasab: boolean;          // "Include 1-part nasab"
  allowOneNasabNisba: boolean;     // "Include 1-part nasab + nisba"
  allowTwoNasab: boolean;          // "Include 2-part nasab"
}

export function createEmptyNameForm(id: string): NameFormData {
  return {
    id,
    kunyas: [''],
    nasab: '',
    nisbas: [''],
    shuhra: '',
    allowRareKunyaNisba: false,
    allowKunyaNasab: false,
    allowOneNasab: false,
    allowOneNasabNisba: false,
    allowTwoNasab: false,
  };
}

const PROCLITICS = ['و', 'ف', 'ب', 'ل', 'ك'];

/**
 * Normalize Arabic text: removes diacritics, normalizes hamza/alif variants
 */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآ]/g, 'ا')           // Normalize hamza carriers
    .replace(/[\u064B-\u065F]/g, '')  // Remove tashkeel
    .trim();
}

/**
 * Parse nasab string into individual name parts
 */
export function getNasabParts(nasab: string): { parts: string[]; isFemale: boolean } {
  const normalized = normalizeArabic(nasab);
  const isFemale = normalized.includes('بنت');
  const parts = normalized.split(/\s+(?:بن|بنت)\s+/).filter(Boolean);
  return { parts, isFemale };
}

/**
 * Build nasab string from parts with appropriate connector
 */
export function buildNasabString(parts: string[], isFemale: boolean): string {
  if (parts.length === 0) return '';
  const connector = isFemale ? ' بنت ' : ' بن ';
  return parts.join(connector);
}

/**
 * Generate kunya variants for any kunya starting with أبو/ابو/ابا/ابي
 */
export function getKunyaVariants(kunya: string): string[] {
  const normalized = normalizeArabic(kunya);
  const match = normalized.match(/^(ابو|ابا|ابي)\s+(.+)/);
  if (!match) return [normalized];
  const base = match[2];
  return [`ابو ${base}`, `ابا ${base}`, `ابي ${base}`];
}

/**
 * Expand a pattern with all proclitic variants
 * The proclitic attaches to the FIRST WORD of the pattern only
 */
export function expandWithProclitics(pattern: string): string[] {
  const words = pattern.trim().split(/\s+/);
  if (words.length === 0) return [pattern];

  const [first, ...rest] = words;
  const restJoined = rest.length > 0 ? ' ' + rest.join(' ') : '';

  return [
    pattern,  // Original
    ...PROCLITICS.map(p => `${p}${first}${restJoined}`)
  ];
}

/**
 * Generate all search patterns for a single name form
 */
export function generatePatterns(form: NameFormData): string[] {
  const patterns = new Set<string>();

  const validKunyas = form.kunyas.filter(k => k.trim());
  const validNisbas = form.nisbas.filter(n => n.trim());
  const { parts: nasabParts, isFemale } = getNasabParts(form.nasab);
  const limitedNasabParts = nasabParts.slice(0, 3); // Limit to first 3 parts
  const normalizedShuhra = form.shuhra.trim() ? normalizeArabic(form.shuhra) : '';

  // Helper to add pattern with normalization
  const addPattern = (p: string) => {
    const normalized = normalizeArabic(p);
    if (normalized) patterns.add(normalized);
  };

  // Get all kunya variants for all kunyas
  const allKunyaVariants: string[] = [];
  for (const kunya of validKunyas) {
    allKunyaVariants.push(...getKunyaVariants(kunya));
  }

  // Base patterns: Full combination (Kunya + Full Nasab + Nisba)
  if (allKunyaVariants.length > 0 && limitedNasabParts.length >= 2) {
    for (const kunyaVariant of allKunyaVariants) {
      // With 2 nasab parts
      const nasab2 = buildNasabString(limitedNasabParts.slice(0, 2), isFemale);
      addPattern(`${kunyaVariant} ${nasab2}`);

      // With each nisba
      for (const nisba of validNisbas) {
        addPattern(`${kunyaVariant} ${nasab2} ${normalizeArabic(nisba)}`);
      }

      // With 3 nasab parts if available
      if (limitedNasabParts.length >= 3) {
        const nasab3 = buildNasabString(limitedNasabParts.slice(0, 3), isFemale);
        addPattern(`${kunyaVariant} ${nasab3}`);

        for (const nisba of validNisbas) {
          addPattern(`${kunyaVariant} ${nasab3} ${normalizeArabic(nisba)}`);
        }
      }

      // Kunya + first nasab name + nisba (e.g., "ابو منصور معمر الاصبهاني")
      for (const nisba of validNisbas) {
        addPattern(`${kunyaVariant} ${limitedNasabParts[0]} ${normalizeArabic(nisba)}`);
      }

      // Kunya + "بن" + rest of nasab (without first name)
      // e.g., "ابو منصور بن احمد", "ابو منصور بن احمد بن زياد"
      const connector = isFemale ? ' بنت ' : ' بن ';
      for (let i = 1; i < limitedNasabParts.length; i++) {
        const restNasab = limitedNasabParts.slice(1, i + 1).join(connector);
        addPattern(`${kunyaVariant}${connector}${restNasab}`);

        // With each nisba
        for (const nisba of validNisbas) {
          addPattern(`${kunyaVariant}${connector}${restNasab} ${normalizeArabic(nisba)}`);
        }
      }
    }
  }

  // Full nasab only (3 parts)
  if (limitedNasabParts.length >= 3) {
    const fullNasab = buildNasabString(limitedNasabParts, isFemale);
    addPattern(fullNasab);

    // With each nisba
    for (const nisba of validNisbas) {
      addPattern(`${fullNasab} ${normalizeArabic(nisba)}`);
    }
  }

  // 2-part nasab with nisba (even without checkbox for base case)
  if (limitedNasabParts.length >= 2) {
    const nasab2 = buildNasabString(limitedNasabParts.slice(0, 2), isFemale);
    // Add nasab with nisbas
    for (const nisba of validNisbas) {
      addPattern(`${nasab2} ${normalizeArabic(nisba)}`);
    }
  }

  // Conditional patterns (checkbox-controlled)

  // allowRareKunyaNisba: kunya + nisba (without nasab)
  if (form.allowRareKunyaNisba && allKunyaVariants.length > 0 && validNisbas.length > 0) {
    for (const kunyaVariant of allKunyaVariants) {
      for (const nisba of validNisbas) {
        addPattern(`${kunyaVariant} ${normalizeArabic(nisba)}`);
      }
    }
  }

  // allowKunyaNasab: kunya + 1st nasab name
  if (form.allowKunyaNasab && allKunyaVariants.length > 0 && limitedNasabParts.length >= 1) {
    for (const kunyaVariant of allKunyaVariants) {
      addPattern(`${kunyaVariant} ${limitedNasabParts[0]}`);

      // Also with nisba
      for (const nisba of validNisbas) {
        addPattern(`${kunyaVariant} ${limitedNasabParts[0]} ${normalizeArabic(nisba)}`);
      }
    }
  }

  // allowOneNasab: Just the first name alone
  if (form.allowOneNasab && limitedNasabParts.length >= 1) {
    addPattern(limitedNasabParts[0]);
  }

  // allowOneNasabNisba: First name + nisba
  if (form.allowOneNasabNisba && limitedNasabParts.length >= 1 && validNisbas.length > 0) {
    for (const nisba of validNisbas) {
      addPattern(`${limitedNasabParts[0]} ${normalizeArabic(nisba)}`);
    }
  }

  // allowTwoNasab: Two-part nasab without nisba
  if (form.allowTwoNasab && limitedNasabParts.length >= 2) {
    const nasab2 = buildNasabString(limitedNasabParts.slice(0, 2), isFemale);
    addPattern(nasab2);
  }

  // Shuhra patterns
  if (normalizedShuhra) {
    // Check if shuhra starts with أبو/ابو and normalize to ابي form
    const shuhraNorm = normalizedShuhra;
    const shuhraSuffix = shuhraNorm.match(/^(ابو|ابا|ابي)\s+(.+)/);

    if (shuhraSuffix) {
      // Use ابي form for المعروف/المشهور
      const shuhraBase = shuhraSuffix[2];
      addPattern(`المعروف بابي ${shuhraBase}`);
      addPattern(`المشهور بابي ${shuhraBase}`);
    } else {
      addPattern(`المعروف ب${shuhraNorm}`);
      addPattern(`المشهور ب${shuhraNorm}`);
    }
  }

  return Array.from(patterns);
}

/**
 * Generate patterns with proclitic expansion for search
 */
export function generateSearchPatterns(form: NameFormData): string[] {
  const basePatterns = generatePatterns(form);
  const expandedPatterns = new Set<string>();

  for (const pattern of basePatterns) {
    for (const expanded of expandWithProclitics(pattern)) {
      expandedPatterns.add(expanded);
    }
  }

  return Array.from(expandedPatterns);
}

/**
 * Collapse kunya variants (ابو/ابا/ابي) into a single "اب*" for display
 */
function collapseKunyaVariantsForDisplay(patterns: string[]): string[] {
  const collapsed = new Set<string>();

  for (const pattern of patterns) {
    // Replace ابو/ابا/ابي at the start with اب*
    const displayPattern = pattern.replace(/^(ابو|ابا|ابي)\s/, 'اب* ');
    collapsed.add(displayPattern);
  }

  return Array.from(collapsed);
}

/**
 * Generate display patterns (without proclitic expansion) for preview
 * Collapses ابو/ابا/ابي variants into اب* for cleaner display
 */
export function generateDisplayPatterns(form: NameFormData): string[] {
  const patterns = generatePatterns(form);
  return collapseKunyaVariantsForDisplay(patterns);
}

/**
 * Generate highlight patterns - includes proclitic expansion for matching text with attached proclitics
 * Used for highlighting matches in the reader (keeps actual kunya forms, not اب*)
 */
export function generateHighlightPatterns(form: NameFormData): string[] {
  return generateSearchPatterns(form);
}

/**
 * Generate all search patterns for multiple forms (for multi-name search)
 */
export function generateAllSearchPatterns(forms: NameFormData[]): string[][] {
  return forms.map(form => generateSearchPatterns(form));
}

/**
 * Generate all display patterns for multiple forms
 */
export function generateAllDisplayPatterns(forms: NameFormData[]): string[][] {
  return forms.map(form => generateDisplayPatterns(form));
}

/**
 * Check if a form has enough data for a valid search
 */
export function isFormValid(form: NameFormData): boolean {
  const validKunyas = form.kunyas.filter(k => k.trim());
  const validNisbas = form.nisbas.filter(n => n.trim());
  const { parts: nasabParts } = getNasabParts(form.nasab);
  const hasShuhra = form.shuhra.trim().length > 0;

  // Shuhra alone is valid
  if (hasShuhra) return true;

  // Count filled fields
  const filledCount =
    (validKunyas.length > 0 ? 1 : 0) +
    (nasabParts.length > 0 ? 1 : 0) +
    (validNisbas.length > 0 ? 1 : 0);

  // At least 2 fields filled
  if (filledCount >= 2) return true;

  // 1 field filled + relevant checkbox enabled
  if (nasabParts.length >= 1 && form.allowOneNasab) return true;
  if (nasabParts.length >= 1 && validNisbas.length > 0 && form.allowOneNasabNisba) return true;
  if (nasabParts.length >= 2 && form.allowTwoNasab) return true;

  return false;
}

/**
 * Check if any form in the array is valid for search
 */
export function hasValidForm(forms: NameFormData[]): boolean {
  return forms.some(form => isFormValid(form));
}

---
name: pdf
description: Process PDF files using npm packages
tags: pdf, document, extraction
---

# PDF Processing Skill

When working with PDF files, use **unpdf** - a modern, zero-dependency PDF library.

## Step 1: Extract Text (Create a Script)

The `npx unpdf extract` CLI command may not work on all systems. Instead, create a script:

```javascript
// extract-pdf.mjs
import { readFile, writeFile } from 'fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';

const pdfPath = process.argv[2];
const outputPath = process.argv[3];

const buffer = await readFile(pdfPath);
const pdf = await getDocumentProxy(new Uint8Array(buffer));
const { text } = await extractText(pdf, { mergePages: true });

await writeFile(outputPath, text);
console.log(`Extracted text saved to ${outputPath}`);
```

Run with:
```bash
node extract-pdf.mjs input.pdf output.txt
```

## Step 2: Check Extraction
Always verify the extraction worked:
```bash
head -20 output.txt
```

## Step 3: Handle Image-Based (Scanned) PDFs

If unpdf extracts empty text, the PDF is likely image-based (scanned document). Use OCR instead:

### Install Required Packages
```bash
npm install pdf-to-img tesseract.js
```

### Create OCR Script (CommonJS)
```javascript
// ocr-pdf.cjs
const { writeFile, readFileSync } = require('fs');
const { promisify } = require('util');
const writeFileAsync = promisify(writeFile);
const { pdf: pdfToImg } = require('pdf-to-img');
const { createWorker } = require('tesseract.js');

async function main(pdfPath, outputPath) {
  const buffer = readFileSync(pdfPath);
  
  // Convert PDF to images with higher scale for better OCR
  const pages = await pdfToImg(buffer, { scale: 3.0 });
  console.log('PDF pages:', pages.length);
  
  let fullText = '';
  let pageNum = 1;
  
  // Create worker once and reuse for better performance
  // Use 'eng' for English, 'chi_sim' for Simplified Chinese, or combine: 'eng+chi_sim'
  const worker = await createWorker('eng');
  
  for await (const page of pages) {
    console.log(`Processing page ${pageNum}...`);
    const { data: { text } } = await worker.recognize(page);
    fullText += `--- Page ${pageNum} ---\n${text}\n\n`;
    pageNum++;
  }
  
  await worker.terminate();
  await writeFileAsync(outputPath, fullText);
  console.log(`OCR text saved to ${outputPath}`);
}

const pdfPath = process.argv[2];
const outputPath = process.argv[3];
main(pdfPath, outputPath);
```

Run with:
```bash
node ocr-pdf.cjs input.pdf output.txt
```

## Language Support for OCR

Tesseract.js supports multiple languages. Specify them when creating the worker:
- `'eng'` - English
- `'chi_sim'` - Simplified Chinese
- `'chi_tra'` - Traditional Chinese
- `'eng+chi_sim'` - English and Simplified Chinese combined

## Example Usage

### Text-based PDF
```bash
node skills/playground/one-off-scripts/extract-pdf.mjs "skills/playground/document.pdf" "skills/playground/extracted-content.txt"
```

### Image-based PDF (OCR)
```bash
node skills/playground/one-off-scripts/ocr-pdf-simple.cjs "skills/playground/TBS.pdf" "skills/playground/tbs-ocr.txt"
```
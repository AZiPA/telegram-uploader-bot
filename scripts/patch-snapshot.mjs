import fs from 'node:fs';

const file = './node_modules/@tgcloud/cli/src/core/snapshot.js';
const target = 'writeSnapshotFile(relPath, content) {';

if (fs.existsSync(file)) {
  const code = fs.readFileSync(file, 'utf8');

  if (code.includes(target) && !code.includes('Buffer.isBuffer(content)')) {
    fs.writeFileSync(
      file,
      code.replace(target, '$& if (typeof content !== "string" && !Buffer.isBuffer(content)) content = "";'),
      'utf8'
    );
    console.log('Patched @tgcloud/cli snapshot handler');
  }
}

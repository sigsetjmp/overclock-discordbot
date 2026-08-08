const fs = require('fs');

function loadJSON(file, init) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    saveJSON(file, init);
    return init;
  }
}

function saveJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { loadJSON, saveJSON };
// Angre/gjør om. Vi lagrer hele redigeringstilstanden som øyeblikksbilder —
// den er liten (bare tall og tekst), og det gjør logikken triviell å stole på.

export class Historikk {
  constructor(start, { maks = 100 } = {}) {
    this.stabel = [klone(start)];
    this.peker = 0;
    this.maks = maks;
  }

  /** Legger til et nytt steg. Alt som lå «foran» i historikken forkastes. */
  push(tilstand) {
    const ny = klone(tilstand);
    if (JSON.stringify(ny) === JSON.stringify(this.stabel[this.peker])) return false;
    this.stabel = this.stabel.slice(0, this.peker + 1);
    this.stabel.push(ny);
    if (this.stabel.length > this.maks) this.stabel.shift();
    this.peker = this.stabel.length - 1;
    return true;
  }

  angre() {
    if (!this.kanAngre) return null;
    this.peker -= 1;
    return klone(this.stabel[this.peker]);
  }

  gjorOm() {
    if (!this.kanGjorOm) return null;
    this.peker += 1;
    return klone(this.stabel[this.peker]);
  }

  get kanAngre() { return this.peker > 0; }
  get kanGjorOm() { return this.peker < this.stabel.length - 1; }
}

function klone(o) {
  return typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o));
}

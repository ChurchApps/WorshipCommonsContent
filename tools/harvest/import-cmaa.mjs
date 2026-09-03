// Imports CMAA "newly composed" English hymns whose *file-level* grant is CC BY 3.0
// (page listing is CC BY 3.0, but many PDFs add ND, NC, "except commercial", or a
// third-party © — those stay out). Staging: .notes/harvest-staging/cmaa/.
// Usage: node tools/harvest/import-cmaa.mjs <staging-dir>
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { idFor, LICENSES, slugify, renderChordpro, writeJson } from "../lib.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = "cmaa";
const SOURCE_URL = "https://musicasacra.com/music/english-hymns-in-the-commons/";
const FILE_URL = name => `https://media.churchmusicassociation.org/books/hymns/${name}`;
const CC_BY_30 = "https://creativecommons.org/licenses/by/3.0/";
const stagingDir = process.argv[2];
if (!stagingDir || !fs.existsSync(stagingDir)) { console.error("Usage: node tools/harvest/import-cmaa.mjs <staging-dir>"); process.exit(1); }

// File-level grant checked against PDF text extract. Hold/refuse stay on disk, not imported.
const SONGS = [
  {
    file: "kp_at.pdf",
    title: "At the Dawning",
    writer: "Kathy Pluth",
    year: 2009,
    key: null,
    bpm: null,
    timeSignature: "8.7.8.7 D",
    body: `Verse 1
At the dawning of creation, God divided light from shade,
And He made us, male and female. In His image we were made.

Chorus
And the life that God created we will honor and defend
From conception to the heavens; from beginning to the end.

Verse 2
God the Father called a people, and He drew them by the hand
And He led them through the desert and into the Promised Land.

Verse 3
In His saving Incarnation, Jesus bore a human frame
To restore the sacred Image hidden by our sin and shame.

Verse 4
And He walked among the people, healed the sick and raised the dead,
And the poor rejoiced at hearing the appealing words He said.

Verse 5
On the Cross, our gracious Savior Jesus laid His body down,
Dying as the Man of Sorrows; giving humankind a crown.`
  },
  {
    file: "kp_he.pdf",
    title: "He Who Walked Upon the Water",
    writer: "Kathleen Pluth, Colin Brumby",
    year: 2009,
    key: "C",
    bpm: 108,
    timeSignature: "4/4",
    body: `Verse 1
He who walked upon the water now is seated on the skies,
and he shares with us his glory that we may with him arise.
He who prayed with tears and groanings intercedes forevermore,
and his hands, with might for healing, knock on every human door.

Verse 2
He will come again in glory, on the final judgement day.
At the final trumpet's sounding heaven and earth will flee away.
Let him enter! Let him enter! Spirit and the Bride say "Come!"
Yes, amen, come soon, Lord Jesus. Come to bring your people home.`
  },
  {
    file: "kp_jesus.pdf",
    title: "Jesus, Let Me Come to You",
    writer: "Kathleen Pluth, Colin Brumby",
    year: 2009,
    key: "C",
    bpm: 108,
    timeSignature: "4/4",
    body: `Verse 1
Jesus, let me come to you as simply as a child.
Chasten those who would prevent me. Let all evil circumvent me.
Jesus, let me come to you. Accept me as a child.

Verse 2
Jesus, look with pity on the sorrows of the world.
Let the poor be safe and sated, innocence be vindicated.
Jesus, bring your mercy to the sorrows of this world.

Verse 3
Jesus, come to meet me in the Blessed Sacrament:
joy beyond my finest pleasure, hidden, lasting, priceless treasure.
Jesus, Lord be with me in your Blessed Sacrament.

Verse 4
Jesus, take me up into the Trinity of life:
God the Father, strong and spacious, God the Spirit, swift and gracious,
Jesus, bring me home into your Trinity of life.`
  },
  {
    file: "kp_o.pdf",
    title: "O Taste, and You Will See",
    writer: "Kathleen Pluth, Colin Brumby",
    year: 2009,
    key: "Eb",
    bpm: 72,
    timeSignature: "3/4",
    body: `Verse 1
O taste, and you will see the goodness of the Lord:
humanity, divinity, the Body and the Blood.

Verse 2
God fed his wand'ring fold with manna from the sky.
Much better This than bread of old: we eat and never die.

Verse 3
Elijah once was fed when he could walk no more.
An angel brought to him that bread: the angels this adore.

Verse 4
To those who would be filled, this food is life indeed.
To give it, Life Himself was killed, and we from death are freed.

Verse 5
O worthy is the Lamb, our slain and risen Lord,
the Son of Mary, God and man, our Eucharist adored.`
  },
  {
    file: "kp_the.pdf",
    title: "The Eyes of All Hope in the Lord",
    writer: "Kathleen Pluth, Colin Brumby",
    year: 2009,
    key: "C",
    bpm: 72,
    timeSignature: "6/8",
    body: `Verse 1
The eyes of all hope in the Lord. He gives them food in proper time.
His open hands shall grant them more than any asks or has in mind.

Verse 2
He needs no storerooms full of food. Five loaves of bread, some fish, provide
enough to feed a multitude upon a lonely mountainside.

Verse 3
The hungry eat their fill of bread: five thousand people satisfied.
And when the crowd has amply fed, twelve baskets-full are set aside.

Verse 4
The Lord is just in all his words: compassionate in all his deeds.
The Lord's almighty hand supports the fainting heart, the trembling knee.

Verse 5
And so let faithful Christians plead an end to hungers, great and small.
The one who knows their every need will not refuse to give them all.

Verse 6
And may our hearts be purified in this great Eucharistic feast
to trust in him whose care abides: our Sacrament, our Life, our Priest.`
  },
  {
    file: "pbeh_all_glory_be.pdf",
    title: "All Glory Be to God",
    writer: "Vincent Uher, Kenneth L. Knott",
    year: 2009,
    key: "Ab",
    bpm: null,
    timeSignature: "4/4",
    body: `Verse 1
All glory be to God on high! Peace, laud and joy be our reply,
to angels singing in the sky.
Praise Jesus Christ, true light from light, tender his love and great his might,
Christ Jesus, saviour, our delight.

Verse 2
O Word and Wisdom, thee we name, Jesus the infant God the same.
Praise and all worship to thy Name.
Son of blest Mary, spotless Lamb, High Priest most holy Great I AM,
Receive our lives into thy hand.

Verse 3
Praise God for Joseph, sainted man, Brave Guardian of God's saving plan,
Protector of the God-made-man.
Praise God for Mary Mother true, Faithful to Jesus her life through,
Mother of God, our Mother too.

Verse 4
Lord Jesus Christ, most holy Lord, With thy blest Spirit be adored
In God's own glory here out-poured.
Joy now to hear thine infant cries! Hope of the simple and the wise!
Love from all souls to thee arise!`
  },
  {
    file: "pbeh_christ_is_our.pdf",
    title: "Christ Is Our Hope Whom We Have Seen",
    writer: "Vincent Uher, Noel Jones",
    year: 2009,
    key: "C",
    bpm: null,
    timeSignature: "4/4",
    body: `Verse 1
Christ is our hope whom we have seen each generation rising.
All human dreams are met in Him the substance of our longing.
He is the light in darkest night Who calls us out with lamps alight.
To work for God's own glory.

Verse 2
Christ is the evidence of God, The Love whose Name sustains us.
Let all the nations of the world Receive the truth: Love saved us.
Love clothed in flesh in Mary's womb, Love raised again from out the tomb,
Love calling us to glory.

Verse 3
Faith, hope, and love are God's own gift To souls who seek Christ's Wisdom.
The Spirit knows this age is dim: We need the Mind of Jesus.
So God pours out both grace and power Upon us all to face this hour,
We will make known God's glory.

Verse 4
Praise be to Christ the Eternal Word Throughout all ages reigning
O glorious Spirit, Lord of Life, Receive our heart's thanksgiving.
To God Most High all glory be For time and for eternity
One God in endless glory.`
  },
  {
    file: "pbeh_great_angels_all.pdf",
    title: "Great Angels All Adore Him",
    writer: "Vincent Uher, Noel Jones",
    year: 2009,
    key: "C",
    bpm: null,
    timeSignature: "4/4",
    body: `Verse 1
Great angels all adore Him and hearts both brave and true.
Behold the Living Saviour Who makes creation new!
Though slain from the foundation of all the world we know,
He triumphs over evil, and in His steps we go.

Verse 2
Remember how in Egypt God's people decked the door
with blood from lambs to mark them their sons Death would pass o'er.
The Lamb of God, great God's Son has shed His Blood to sign
the Cross, the Christian's doorway into the Life divine.

Verse 3
Death's stronghold could not hold Him. The gates of hell He smashed.
Christ frees from satan's clutching all souls His Blood has washed.
Alive and ris'n from death's tomb in victory to reign,
He soon returns. Behold Him! Hallelujah! Amen!`
  },
  {
    file: "pbeh_sweet_is_the_work.pdf",
    title: "Sweet Is the Work",
    writer: "Isaac Watts, Craig Klampe",
    year: 2009,
    key: "F",
    bpm: null,
    timeSignature: "4/4",
    body: `Verse 1
Sweet is the work, my God, my King, To praise Thy name, give thanks and sing,
To show Thy love by morning light, And talk of all Thy truths at night.

Verse 2
Sweet is the day of sacred rest. No mortal care shall seize my breast.
Oh, may my heart in tune be found, Like David's harp of solemn sound!

Verse 3
My heart shall triumph in my Lord And bless His works and bless his word.
Thy works of grace, how bright they shine! How deep Thy counsels, how divine!

Verse 4
But, oh, what triumph shall I raise To Thy dear name through endless days,
When in the realms of joy I see Thy face in full felicity!`
  }
];

let imported = 0;
for (const row of SONGS) {
  const src = path.join(stagingDir, row.file);
  if (!fs.existsSync(src)) { console.warn(`SKIP  ${row.file}: not in staging`); continue; }
  const outDir = path.join(ROOT, "songs", "en", LICENSES["CC-BY"].section, slugify(row.title));
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(src, path.join(outDir, "sheetPdf.pdf"));
  const song = {
    id: idFor(row.title),
    title: row.title,
    writer: row.writer,
    year: row.year,
    language: "English",
    themes: "",
    key: row.key,
    bpm: row.bpm,
    timeSignature: row.timeSignature.includes("/") ? row.timeSignature : "4/4",
    meter: row.timeSignature.includes("/") ? null : row.timeSignature,
    scripture: null,
    license: "CC-BY",
    licenseVersion: "3.0",
    licenseUrl: CC_BY_30,
    attribution: { required: true, text: row.writer, link: FILE_URL(row.file) },
    churchCount: 0,
    hymnalCount: 0,
    provenance: { text: SOURCE },
    uploads: { sheetPdf: "sheetPdf.pdf" }
  };
  writeJson(path.join(outDir, "song.json"), song);
  fs.writeFileSync(path.join(outDir, "lyrics.chordpro"), renderChordpro(song, row.body));
  imported++;
}
console.log(`imported ${imported} CMAA CC-BY songs; skipped ND/NC/except-commercial/CanticaNOVA holds. run write-sources-txt, build-catalog, validate`);

// Generated class phrases: three different words and a 2-digit number, like "otter-bagel-canyon-42".
// Short, spellable, classroom-safe words: no names, no body words, nothing with a second meaning.
// 200 words give 200 x 199 x 198 x 90 = about 700 million phrases (over 2^29), so guessing is
// hopeless at the per-IP limit (src/ip-limit.ts). test/phrase.test.mjs checks the list.
export const WORDS = [
  'acorn', 'anchor', 'apple', 'apricot', 'avocado', 'backpack', 'badger', 'bagel', 'balloon', 'banjo',
  'basket', 'beetle', 'bicycle', 'biscuit', 'bison', 'blanket', 'blue', 'bottle', 'breeze', 'bridge',
  'bronze', 'bucket', 'button', 'cabbage', 'cable', 'cactus', 'camel', 'camera', 'candle', 'canoe',
  'canyon', 'carrot', 'cashew', 'castle', 'cedar', 'celery', 'cereal', 'chalk', 'cheetah', 'cinnamon',
  'cliff', 'cloud', 'coast', 'cobalt', 'cocoa', 'coconut', 'comet', 'compass', 'cookie', 'copper',
  'crayon', 'cricket', 'crimson', 'crown', 'delta', 'desert', 'dolphin', 'dragon', 'drum', 'dune',
  'eagle', 'engine', 'falcon', 'feather', 'fern', 'ferry', 'flag', 'forest', 'galaxy', 'garden',
  'gecko', 'geyser', 'giraffe', 'glacier', 'glove', 'golden', 'goose', 'granite', 'grape', 'green',
  'guitar', 'hammer', 'hamster', 'harbor', 'hedgehog', 'helmet', 'heron', 'igloo', 'iguana', 'indigo',
  'island', 'jacket', 'jungle', 'kayak', 'kettle', 'kite', 'kiwi', 'koala', 'ladder', 'lagoon',
  'lake', 'lamp', 'lantern', 'laptop', 'lemon', 'lemur', 'lettuce', 'lime', 'lizard', 'llama',
  'lobster', 'magnet', 'mango', 'maple', 'marble', 'marker', 'meteor', 'mint', 'mirror', 'mitten',
  'moon', 'moose', 'narwhal', 'nebula', 'nickel', 'noodle', 'notebook', 'oatmeal', 'ocean', 'orange',
  'orbit', 'ostrich', 'otter', 'paddle', 'pancake', 'panda', 'papaya', 'parrot', 'pasta', 'peanut',
  'pebble', 'pelican', 'pencil', 'penguin', 'piano', 'pillow', 'pilot', 'pine', 'pizza', 'planet',
  'plum', 'pond', 'popcorn', 'potato', 'prairie', 'pretzel', 'puffin', 'pumpkin', 'purple', 'puzzle',
  'quartz', 'quilt', 'rabbit', 'radio', 'radish', 'rainbow', 'raisin', 'ranger', 'reef', 'robot',
  'rocket', 'ruler', 'saddle', 'sailor', 'salmon', 'satellite', 'scooter', 'sesame', 'shovel', 'silver',
  'sled', 'sloth', 'snail', 'sparrow', 'spruce', 'squid', 'sticker', 'sunset', 'swan', 'tandem',
  'teapot', 'telescope', 'thunder', 'ticket', 'tiger', 'timber', 'toast', 'tomato', 'toucan', 'tractor',
];

export function generatePhrase(): string {
  const picked: string[] = [];
  while (picked.length < 3) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    const w = WORDS[n % WORDS.length];
    if (!picked.includes(w)) picked.push(w); // "robot-robot-maple" reads like a typo
  }
  const number = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90); // always 2 digits
  return `${picked.join('-')}-${number}`;
}

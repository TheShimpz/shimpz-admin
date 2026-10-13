// Every interface language's complete Admin catalog at once, for the tests and benchmarks that compare languages. The app
// itself loads only the active language (i18n.js), each one its own chunk under messages/.
import ar from './messages/ar.js';
import de from './messages/de.js';
import en from './messages/en.js';
import es from './messages/es.js';
import fr from './messages/fr.js';
import ja from './messages/ja.js';
import pt from './messages/pt.js';
import zh from './messages/zh.js';

export const messages = { en, pt, es, zh, fr, de, ja, ar };

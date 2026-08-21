/**
 * @metaxia/scriptures-source-stepbible-versification
 *
 * STEPBible TVTMS cross-tradition versification (MT / LXX / English) for
 * @metaxia/scriptures-core. Importing this module auto-registers the source
 * with core's versification registry.
 */
import { registerVersification } from '@metaxia/scriptures-core';
import { sourceInfo } from './source.js';

registerVersification(sourceInfo);

export { sourceInfo };

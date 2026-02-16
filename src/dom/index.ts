export type { NavDir } from "./controls";

export { bindItemFrame, createComponent, el, setBodyClasses } from "./base";

export {
  buildItemHeader,
  buildTextField,
  clampCaretToText,
  caret0,
  caretAt,
  caretEnd,
  editTargetsForItem,
  fieldsFromConn,
  handleContainerIntent,
  moveWithinItemEditTargets,
  patchConn,
  resolveFocusAfterRemove,
  getTextForTarget,
  typeCharIntoFocusedTextInput,
} from "./controls";

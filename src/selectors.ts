export const PAGE_SHELL_ANCHOR = '[role="main"]';

export const THREAD_LINK_SELECTOR = [
  'a[href*="/messages/t/"]',
  'a[href*="messenger.com/t/"]',
  'a[href*="/marketplace/inbox"]'
].join(", ");

export const LISTING_CARD_LINK_SELECTOR = 'a[href*="/marketplace/item/"]';

export const PHOTO_INPUT_SELECTOR = 'input[type="file"]';

export const TITLE_FIELD_SELECTORS = [
  'input[aria-label*="Title" i]',
  'input[placeholder*="Title" i]',
  '[role="textbox"][aria-label*="Title" i]'
];

export const PRICE_FIELD_SELECTORS = [
  'input[aria-label*="Price" i]',
  'input[placeholder*="Price" i]',
  'input[inputmode="decimal"]',
  'input[type="number"]'
];

export const CATEGORY_DROPDOWN_SELECTORS = [
  '[aria-label*="Category" i]',
  '[role="combobox"]:has-text("Category")',
  'label:has-text("Category")'
];

export const CONDITION_DROPDOWN_SELECTORS = [
  '[aria-label*="Condition" i]',
  '[role="combobox"]:has-text("Condition")',
  'label:has-text("Condition")'
];

export const DESCRIPTION_FIELD_SELECTORS = [
  'textarea[aria-label*="Description" i]',
  'textarea[placeholder*="Description" i]',
  '[role="textbox"][aria-label*="Description" i]',
  '[contenteditable="true"][aria-label*="Description" i]'
];

export const LOCATION_FIELD_SELECTORS = [
  'input[aria-label*="Location" i]',
  'input[placeholder*="Location" i]',
  '[role="combobox"][aria-label*="Location" i]'
];

export const LOCATION_SUGGESTION_SELECTOR = '[role="option"]';

export const COMPOSER_SELECTORS = [
  '[role="textbox"][contenteditable="true"][aria-label*="Message" i]',
  '[role="textbox"][contenteditable="true"][aria-label*="Type a message" i]',
  '[role="textbox"][contenteditable="true"][aria-label*="Reply" i]',
  '[contenteditable="true"][aria-label*="Message" i]',
  '[contenteditable="true"][aria-label*="Type a message" i]',
  '[contenteditable="true"][aria-label*="Reply" i]'
];

export const CREATE_FORM_ANCHORS = [
  ...TITLE_FIELD_SELECTORS,
  PHOTO_INPUT_SELECTOR,
  PAGE_SHELL_ANCHOR
];

export const SELLER_LISTINGS_ANCHORS = [
  LISTING_CARD_LINK_SELECTOR,
  PAGE_SHELL_ANCHOR
];

export const LISTING_DETAIL_ANCHORS = ["h1", PAGE_SHELL_ANCHOR];

export const MESSAGE_INBOX_ANCHORS = [THREAD_LINK_SELECTOR, PAGE_SHELL_ANCHOR];

export const MESSAGE_THREAD_ANCHORS = [...COMPOSER_SELECTORS, PAGE_SHELL_ANCHOR];

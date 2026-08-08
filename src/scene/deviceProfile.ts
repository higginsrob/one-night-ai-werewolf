/** iPad Mini / phones — also catches iPadOS desktop-UA spoofing. */
export const isCoarseMobile =
  typeof navigator !== 'undefined' &&
  (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
    (typeof window !== 'undefined' && window.innerWidth < 700))

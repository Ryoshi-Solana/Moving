'use client';

export function FocusSearchButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        window.dispatchEvent(new Event('moving:focus-search'));
      }}
      className="inline-flex h-12 shrink-0 items-center rounded-[7px] bg-teal px-6 text-[14px] font-semibold text-void transition-[filter] duration-150 hover:brightness-110 active:brightness-95"
    >
      Investigate a coin
    </button>
  );
}

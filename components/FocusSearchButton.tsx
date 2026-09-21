'use client';

export function FocusSearchButton() {
  return (
    <button
      type="button"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        window.dispatchEvent(new Event('moving:focus-search'));
      }}
      className="rounded-[2px] bg-mint px-8 py-3.5 text-[13px] font-semibold uppercase tracking-[0.12em] text-void transition-all duration-150 hover:brightness-110 active:brightness-95"
    >
      Analyze a coin
    </button>
  );
}

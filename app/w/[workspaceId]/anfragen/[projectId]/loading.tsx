function SkeletonLine({ className = "" }: { className?: string }) {
  return (
    <div
      className={`h-4 animate-pulse rounded bg-slate-200 motion-reduce:animate-none ${className}`}
    />
  );
}

export default function ProjectDetailLoading() {
  return (
    <main
      className="min-h-screen bg-slate-50"
      aria-busy="true"
      aria-label="Projektakte wird geladen"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <span className="sr-only">Projektakte wird geladen …</span>
        <SkeletonLine className="mb-8 h-5 w-44" />
        <div className="mb-8 border-b border-slate-200 pb-7">
          <SkeletonLine className="mb-3 w-24" />
          <SkeletonLine className="h-8 w-full max-w-md" />
          <SkeletonLine className="mt-3 w-52" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
          <div className="grid gap-6">
            {[0, 1, 2, 3].map((item) => (
              <section
                key={item}
                className="rounded-lg border border-slate-200 bg-white p-6"
              >
                <SkeletonLine className="mb-6 h-5 w-40" />
                <div className="grid gap-5">
                  <SkeletonLine className="w-full" />
                  <SkeletonLine className="w-5/6" />
                  <SkeletonLine className="w-3/4" />
                </div>
              </section>
            ))}
          </div>
          <div className="grid content-start gap-6">
            {[0, 1].map((item) => (
              <section
                key={item}
                className="rounded-lg border border-slate-200 bg-white p-6"
              >
                <SkeletonLine className="mb-5 h-5 w-28" />
                <SkeletonLine className="mb-3 w-full" />
                <SkeletonLine className="w-4/5" />
              </section>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

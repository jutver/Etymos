import { cn } from "@etymos/shared";

/** Three lines that fold into an X: the outer two swing to the middle and
 * cross, the middle one fades out. Takes the button's text colour. */
export function MenuIcon({ open }: { open: boolean }) {
  const bar = "absolute left-0 h-[1.5px] w-full rounded-full bg-current transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.65,0,0.35,1)] motion-reduce:transition-none";
  return (
    <span aria-hidden="true" className="relative block h-3.5 w-[18px]">
      <span className={cn(bar, "top-0", open && "translate-y-[6.25px] rotate-45")} />
      <span className={cn(bar, "top-[6.25px]", open && "scale-x-0 opacity-0")} />
      <span className={cn(bar, "bottom-0", open && "-translate-y-[6.25px] -rotate-45")} />
    </span>
  );
}

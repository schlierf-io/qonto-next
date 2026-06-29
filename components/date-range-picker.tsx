"use client";

import * as React from "react";
import { CalendarIcon } from "lucide-react";
import type { DateRange as RdpRange } from "react-day-picker";
import { de } from "date-fns/locale";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate } from "@/lib/format";
import type { DateRange } from "@/lib/qonto/types";

interface Props {
  onDateRangeSelected: (range: DateRange) => void;
}

/** Default to the full previous month (matches the Angular picker). */
function previousMonthRange(): RdpRange {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0) };
}

export function DateRangePicker({ onDateRangeSelected }: Props) {
  const [range, setRange] = React.useState<RdpRange | undefined>(
    previousMonthRange,
  );
  const [open, setOpen] = React.useState(false);

  // Emit the default range once on mount.
  React.useEffect(() => {
    const initial = previousMonthRange();
    onDateRangeSelected({ start: initial.from ?? null, end: initial.to ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = (next: RdpRange | undefined) => {
    setRange(next);
    if (next?.from && next?.to) {
      onDateRangeSelected({ start: next.from, end: next.to });
    }
  };

  const label =
    range?.from && range?.to
      ? `${formatDate(range.from)} – ${formatDate(range.to)}`
      : range?.from
        ? formatDate(range.from)
        : "Zeitraum wählen";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-muted-foreground">Zeitraum</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="w-[320px] justify-start gap-2 font-normal"
          >
            <CalendarIcon className="size-4" />
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={range}
            onSelect={handleSelect}
            defaultMonth={range?.from}
            numberOfMonths={2}
            locale={de}
            autoFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

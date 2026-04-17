import * as SliderPrimitive from "@radix-ui/react-slider"

interface SliderProps {
  min: number
  max: number
  step: number
  value: number
  onValueChange: (value: number) => void
}

export function Slider({ min, max, step, value, onValueChange }: SliderProps) {
  return (
    <SliderPrimitive.Root
      className="slider-root"
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={(values) => onValueChange(values[0])}
    >
      <SliderPrimitive.Track className="slider-track">
        <SliderPrimitive.Range className="slider-range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="slider-thumb" />
    </SliderPrimitive.Root>
  )
}

import React, { useState, useEffect } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';

interface DeathDateFilterProps {
  range: { min: number; max: number };
  value: { min: number; max: number };
  onChange: (min: number, max: number) => void;
}

const DeathDateFilter: React.FC<DeathDateFilterProps> = ({
  range,
  value,
  onChange
}) => {
  // Local state for handling slider interactions
  const [sliderValue, setSliderValue] = useState<[number, number]>([
    value.min || range.min,
    value.max || range.max
  ]);
  
  // Update slider value when props change
  useEffect(() => {
    setSliderValue([
      value.min || range.min,
      value.max || range.max
    ]);
  }, [value, range]);
  
  // Handle slider change
  const handleSliderChange = (newValue: number | number[]) => {
    if (Array.isArray(newValue)) {
      setSliderValue([newValue[0], newValue[1]]);
    }
  };
  
  // Apply changes after slider interaction ends
  const handleAfterChange = (newValue: number | number[]) => {
    if (Array.isArray(newValue)) {
      onChange(newValue[0], newValue[1]);
    }
  };
  
  // Handle input change
  const handleInputChange = (type: 'min' | 'max', e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseInt(e.target.value, 10);
    
    if (isNaN(newValue)) {
      return;
    }
    
    if (type === 'min') {
      const clampedValue = Math.max(range.min, Math.min(sliderValue[1], newValue));
      setSliderValue([clampedValue, sliderValue[1]]);
    } else {
      const clampedValue = Math.min(range.max, Math.max(sliderValue[0], newValue));
      setSliderValue([sliderValue[0], clampedValue]);
    }
  };
  
  // Apply input value on blur
  const handleInputBlur = () => {
    onChange(sliderValue[0], sliderValue[1]);
  };
  
  // Reset to full range
  const handleReset = () => {
    onChange(range.min, range.max);
  };
  
  // Is the current range different from the full range?
  const isFiltered = sliderValue[0] > range.min || sliderValue[1] < range.max;
  
  return (
    <div className="filter-group">
      <div className="flex justify-between items-center mb-2">
        <h4 className="text-md font-medium">تاريخ الوفاة</h4>
        
        {isFiltered && (
          <button
            className="text-xs text-indigo-600 hover:underline"
            onClick={handleReset}
          >
            إعادة ضبط
          </button>
        )}
      </div>
      
      <div className="px-4 py-6">
        <Slider
          range
          min={range.min}
          max={range.max}
          value={sliderValue}
          onChange={handleSliderChange}
          onAfterChange={handleAfterChange}
          trackStyle={[{ backgroundColor: '#4f46e5' }]}
          handleStyle={[
            { borderColor: '#4f46e5', backgroundColor: '#4f46e5' },
            { borderColor: '#4f46e5', backgroundColor: '#4f46e5' }
          ]}
          railStyle={{ backgroundColor: '#e5e7eb' }}
        />
        
        <div className="flex justify-between items-center mt-4">
          <div className="w-24">
            <label className="block text-xs text-gray-500 mb-1">من</label>
            <input
              type="number"
              value={sliderValue[0]}
              onChange={(e) => handleInputChange('min', e)}
              onBlur={handleInputBlur}
              min={range.min}
              max={sliderValue[1]}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          
          <div className="w-24">
            <label className="block text-xs text-gray-500 mb-1">إلى</label>
            <input
              type="number"
              value={sliderValue[1]}
              onChange={(e) => handleInputChange('max', e)}
              onBlur={handleInputBlur}
              min={sliderValue[0]}
              max={range.max}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
      </div>
      
      {isFiltered && (
        <p className="text-sm text-gray-500 mt-2">
          يعرض المؤلفون الذين توفوا بين {sliderValue[0]} و {sliderValue[1]} هجري
        </p>
      )}
    </div>
  );
};

export default DeathDateFilter;
import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import defaultAvatar from '../assets/chanakya_default.png';
import hoverAvatar from '../assets/chanakya_hover.png';

export default function ChanakyaAvatar({ accentColor = '#3b82f6' }) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className="relative flex items-center justify-center cursor-pointer mb-4 mx-auto w-32 h-32"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Meditating Aura (Breathing effect) */}
      <motion.div
        animate={isHovered ? {
          scale: [1, 1.2, 1],
          opacity: [0.5, 0.8, 0.5],
        } : {
          scale: [1, 1.05, 1],
          opacity: [0.2, 0.4, 0.2],
        }}
        transition={{
          duration: isHovered ? 1.5 : 4,
          repeat: Infinity,
          ease: "easeInOut"
        }}
        className="absolute inset-0 rounded-full blur-2xl"
        style={{ background: `radial-gradient(circle, ${accentColor} 0%, transparent 70%)` }}
      />

      <div className="relative z-10 w-28 h-28 rounded-full border-2 flex items-center justify-center overflow-hidden shadow-2xl transition-transform duration-500"
           style={{ 
             borderColor: `${accentColor}50`, 
             boxShadow: `0 0 30px ${accentColor}30`, 
             transform: isHovered ? 'scale(1.05)' : 'scale(1)',
             background: '#000'
           }}>
        
        <AnimatePresence mode="wait">
          {!isHovered ? (
            <motion.img 
              key="default"
              src={defaultAvatar}
              alt="Chanakya Meditating"
              className="w-full h-full object-cover"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            />
          ) : (
            <motion.img 
              key="hover"
              src={hoverAvatar}
              alt="Chanakya Awake"
              className="w-full h-full object-cover"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            />
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}

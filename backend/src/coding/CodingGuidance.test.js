import test from 'node:test';
import assert from 'node:assert/strict';
import { codingGuidance } from './CodingGuidance.js';

test('Three.js and 3D goals receive the Three.js project guidance', () => {
  for (const goal of ['build a Three.js solar system', 'make a 3D model viewer', 'webgl cube'])
    assert.match(codingGuidance(goal), /3D \(Three\.js\)/);
});

test('unrelated goals do not receive the Three.js guidance', () => {
  assert.doesNotMatch(codingGuidance('write a python calculator'), /Three\.js/);
});

test('3D guidance keeps the build-then-preview workflow and local-only assets', () => {
  const text = codingGuidance('three.js scene');
  assert.match(text, /npm run build must pass/);
  assert.match(text, /port=5175/);
  assert.match(text, /never fetch remote assets/);
});

test('Rust, Go and .NET goals receive their toolchain guidance', () => {
  assert.match(codingGuidance('build a rust cli with cargo'), /Rust: write Cargo\.toml/);
  assert.match(codingGuidance('write a golang http server'), /Go: write go\.mod/);
  assert.match(
    codingGuidance('create an ASP.NET web api in C#'),
    /\.NET: dotnet new is unavailable/,
  );
  assert.doesNotMatch(codingGuidance('build a react website'), /Rust:|Go:|\.NET:/);
  assert.doesNotMatch(codingGuidance('go to the next step and fix the bug'), /Go: write/);
});

test('Java, C/C++, SQL and embedded goals receive their toolchain guidance', () => {
  assert.match(codingGuidance('build a Spring Boot app with Maven'), /Java: needs the JDK/);
  assert.match(
    codingGuidance('write a C++ program with CMake'),
    /C\/C\+\+: runtime\.install cmake/,
  );
  assert.match(codingGuidance('design a SQLite database schema'), /SQL: write \.sql files/);
  assert.match(
    codingGuidance('firmware for an STM32 microcontroller'),
    /Embedded C \(build only\)/,
  );
  assert.doesNotMatch(codingGuidance('write javascript for a web page'), /Java: needs/);
  assert.doesNotMatch(codingGuidance('build a react website'), /Java:|C\/C\+\+:|SQL:|Embedded C/);
});

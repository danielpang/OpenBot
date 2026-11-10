Pod::Spec.new do |s|
  s.name = 'OpenBotsNative'
  s.version = '1.0.0'
  s.summary = 'Device-only shared notification keys for OpenBots'
  s.description = s.summary
  s.license = { :type => 'Proprietary', :file => '../LICENSE' }
  s.author = 'OpenBots'
  s.homepage = 'https://github.com/openbots'
  s.platforms = { :ios => '17.0' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.0'
end
